import { describe, it, expect } from 'vitest';
import { SarahConfigSchema } from './config-schema.js';

describe('SarahConfigSchema', () => {
  it('parses an empty object with all defaults', () => {
    const result = SarahConfigSchema.parse({});

    expect(result.onboarding.setupComplete).toBe(false);
    expect(result.profile.displayName).toBe('');
    expect(result.personalization.responseStyle).toBe('mittel');
    expect(result.controls.voiceMode).toBe('off');
    expect(result.controls.pushToTalkKey).toBe('F9');
    expect(result.personalization.accentColor).toBe('#00d4ff');
    expect(result.llm.baseUrl).toBe('http://localhost:11434');
    expect(result.trust.fileAccess).toBe('specific-folders');
  });

  it('preserves provided values', () => {
    const result = SarahConfigSchema.parse({
      profile: { displayName: 'Martin', city: 'Berlin' },
      controls: { voiceMode: 'push-to-talk' },
    });

    expect(result.profile.displayName).toBe('Martin');
    expect(result.profile.city).toBe('Berlin');
    expect(result.controls.voiceMode).toBe('push-to-talk');
    expect(result.personalization.responseStyle).toBe('mittel');
  });

  it('migrates legacy fileAccess "full" to "all"', () => {
    const result = SarahConfigSchema.parse({
      trust: { fileAccess: 'full' },
    });

    expect(result.trust.fileAccess).toBe('all');
  });

  it('returns error for invalid enum values via safeParse', () => {
    const result = SarahConfigSchema.safeParse({
      controls: { voiceMode: 'invalid-mode' },
    });

    expect(result.success).toBe(false);
  });

  it('handles a full realistic config', () => {
    const full = {
      onboarding: { setupComplete: true },
      profile: {
        displayName: 'Martin',
        city: 'Berlin',
        usagePurposes: ['Programmieren', 'Design'],
        hobbies: ['Gaming'],
        responseStyle: 'mittel',
        tone: 'locker',
      },
      skills: {
        programming: 'Fortgeschritten',
        programmingStack: ['TypeScript', 'React'],
      },
      resources: {
        programs: [{
          name: 'VS Code',
          path: 'C:\\Program Files\\VS Code\\code.exe',
          type: 'exe',
          source: 'detected',
          verified: true,
          aliases: ['Code', 'VSCode'],
        }],
      },
      trust: { confirmationLevel: 'standard', memoryAllowed: true },
      personalization: { quirk: 'nerd', characterTraits: ['Humorvoll'] },
      controls: { voiceMode: 'push-to-talk', pushToTalkKey: 'F10' },
      llm: { model: 'qwen3.5:4b' },
    };

    const result = SarahConfigSchema.parse(full);
    expect(result.profile.displayName).toBe('Martin');
    expect(result.resources.programs[0].name).toBe('VS Code');
    expect(result.controls.pushToTalkKey).toBe('F10');
    expect(result.llm.model).toBe('qwen3.5:4b');
  });
});
