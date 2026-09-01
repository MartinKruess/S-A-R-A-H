import { describe, it, expect } from 'vitest';
import { mergeOptions, reconstructEntries } from '../../../src/renderer/shared/program-picker-logic.js';
import type { ProgramEntry } from '../../../src/core/config-schema.js';
import type { ProgramOption } from '../../../src/renderer/shared/program-detection.js';

const detectedOpt = (name: string): ProgramOption => ({ value: name, label: name, icon: '📦' });

describe('mergeOptions', () => {
  it('returns detected options when nothing selected manually', () => {
    const detected: ProgramOption[] = [detectedOpt('Chrome'), detectedOpt('Firefox')];
    const selected: ProgramEntry[] = [];
    expect(mergeOptions(detected, selected).map(o => o.value)).toEqual(['Chrome', 'Firefox']);
  });

  it('appends manual-source selected entries not present in detected', () => {
    const detected: ProgramOption[] = [detectedOpt('Chrome')];
    const selected: ProgramEntry[] = [
      { name: 'Chrome', path: '', type: 'exe', source: 'detected', verified: true, aliases: [] },
      { name: 'CustomApp', path: '', type: 'exe', source: 'manual', verified: false, aliases: [] },
    ];
    const merged = mergeOptions(detected, selected);
    expect(merged.map(o => o.value)).toEqual(['Chrome', 'CustomApp']);
  });

  it('does not duplicate when a manual entry matches a detected option', () => {
    const detected: ProgramOption[] = [detectedOpt('Chrome')];
    const selected: ProgramEntry[] = [
      { name: 'Chrome', path: '', type: 'exe', source: 'manual', verified: false, aliases: [] },
    ];
    const merged = mergeOptions(detected, selected);
    expect(merged.map(o => o.value)).toEqual(['Chrome']);
  });
});

describe('reconstructEntries', () => {
  const detected: ProgramEntry[] = [
    { name: 'Chrome', path: 'C:/chrome.exe', type: 'exe', source: 'detected', verified: true, aliases: ['gc'] },
  ];
  const previous: ProgramEntry[] = [
    { name: 'CustomApp', path: 'D:/tool.exe', type: 'exe', source: 'manual', verified: false, aliases: [] },
  ];
  const buildManualEntry = (name: string): ProgramEntry => ({
    name, path: '', type: 'exe', source: 'manual', verified: false, aliases: [],
  });

  it('prefers detected entry over manual fallback', () => {
    const result = reconstructEntries(['Chrome'], detected, previous, buildManualEntry);
    expect(result[0].source).toBe('detected');
    expect(result[0].path).toBe('C:/chrome.exe');
  });

  it('keeps previously-selected manual entries when not detected', () => {
    const result = reconstructEntries(['CustomApp'], detected, previous, buildManualEntry);
    expect(result[0].source).toBe('manual');
    expect(result[0].path).toBe('D:/tool.exe');
  });

  it('builds new manual entry when neither detected nor previous has it', () => {
    const result = reconstructEntries(['BrandNew'], detected, previous, buildManualEntry);
    expect(result[0].source).toBe('manual');
    expect(result[0].name).toBe('BrandNew');
    expect(result[0].path).toBe('');
  });

  it('preserves order of input names', () => {
    const result = reconstructEntries(['CustomApp', 'Chrome', 'BrandNew'], detected, previous, buildManualEntry);
    expect(result.map(e => e.name)).toEqual(['CustomApp', 'Chrome', 'BrandNew']);
  });
});
