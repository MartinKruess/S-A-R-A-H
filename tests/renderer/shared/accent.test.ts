import { describe, it, expect } from 'vitest';
import { colorToTheme } from '../../../src/renderer/shared/accent.js';

describe('colorToTheme', () => {
  it('maps the 8 preset hex values to their theme keys', () => {
    expect(colorToTheme('#00d4ff')).toBe('cyan');
    expect(colorToTheme('#4466ff')).toBe('blue');
    expect(colorToTheme('#8855ff')).toBe('violet');
    expect(colorToTheme('#ff8844')).toBe('orange');
    expect(colorToTheme('#44ff88')).toBe('green');
    expect(colorToTheme('#ff4488')).toBe('pink');
    expect(colorToTheme('#ffcc00')).toBe('gold');
    expect(colorToTheme('#ff5555')).toBe('red');
  });

  it('falls back to "cyan" for unknown hex values', () => {
    expect(colorToTheme('#123456')).toBe('cyan');
    expect(colorToTheme('#000000')).toBe('cyan');
  });

  it('is case-insensitive for the hex input', () => {
    expect(colorToTheme('#FF8844')).toBe('orange');
    expect(colorToTheme('#Ff5555')).toBe('red');
  });
});
