import { describe, expect, it } from 'vitest';
import { SarahConfigSchema } from '../../../src/core/config-schema.js';
import { resolveProfileResponse } from '../../../src/services/llm/profile-response.js';

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
    expect(resolveProfileResponse('Wie heiße ich und öffne Spotify?', profile('Martin'))).toBeNull();
    expect(resolveProfileResponse('Wie heiße ich, aber antworte ausführlich.', profile('Martin'))).toBeNull();
    expect(resolveProfileResponse('Wie heiße ich? Öffne Spotify.', profile('Martin'))).toBeNull();
    expect(resolveProfileResponse('Wie heiße ich; anschließend öffne Spotify.', profile('Martin'))).toBeNull();
  });
});
