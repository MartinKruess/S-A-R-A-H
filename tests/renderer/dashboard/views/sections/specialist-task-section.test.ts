import { describe, expect, it } from 'vitest';
import { isSafeSpecialistCitation } from '../../../../../src/renderer/dashboard/views/sections/specialist-task-section.js';

describe('specialist citation boundary', () => {
  it.each(['https://example.com/source', 'http://example.com/source'])('permits web sources %s', (url) => {
    expect(isSafeSpecialistCitation(url)).toBe(true);
  });
  it.each(['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,test', 'https://user:password@example.com', 'not a url'])('rejects unsafe source %s', (url) => {
    expect(isSafeSpecialistCitation(url)).toBe(false);
  });
});
