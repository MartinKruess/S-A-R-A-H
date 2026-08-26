import { describe, expect, it } from 'vitest';
import { SarahConfigSchema } from '../../core/config-schema.js';
import { resolveProfileResponse } from './profile-response.js';

function profile(displayName: string) {
  return SarahConfigSchema.parse({ profile: { displayName } }).profile;
}

describe('resolveProfileResponse', () => {
  it.each([
    'Wie heiße ich?',
    'Wie heiß ich?',
    'Wie ist mein Name?',
    'Was ist mein Name?',
    'Kennst du meinen Namen?',
    'Weißt du eigentlich, wie ich heiße?',
  ])('answers known name questions deterministically: %s', (question) => {
    expect(resolveProfileResponse(question, profile('Martin'))).toBe('Du heißt Martin.');
  });

  it('answers honestly when no preferred name is configured', () => {
    expect(resolveProfileResponse('Wie heiße ich?', profile(''))).toBe(
      'Du hast mir noch keinen Namen genannt.',
    );
  });

  it('does not intercept broader profile or conversation questions', () => {
    expect(resolveProfileResponse('Was weißt du über mich?', profile('Martin'))).toBeNull();
  });
});
