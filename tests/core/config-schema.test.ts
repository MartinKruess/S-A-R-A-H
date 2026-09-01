import { describe, it, expect } from 'vitest';
import { SarahConfigSchema } from '../../src/core/config-schema.js';
import { MAX_MEMORY_EXCLUSIONS, MAX_MEMORY_EXCLUSION_LENGTH } from '../../src/core/memory-exclusions.js';

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
    expect(result.trust.webAccessAllowed).toBe(true);
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

  it('rejects unsupported push-to-talk keys so config repair can restore F9', () => {
    const result = SarahConfigSchema.safeParse({
      controls: { voiceMode: 'push-to-talk', pushToTalkKey: 'Space' },
    });

    expect(result.success).toBe(false);
    expect(SarahConfigSchema.parse({}).controls.pushToTalkKey).toBe('F9');
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
      llm: { model: 'qwen3:8b' },
    };

    const result = SarahConfigSchema.parse(full);
    expect(result.profile.displayName).toBe('Martin');
    expect(result.resources.programs[0].name).toBe('VS Code');
    expect(result.controls.pushToTalkKey).toBe('F10');
    expect(result.llm.workerModel).toBe('qwen3:8b');
  });

  it('profile has new optional field defaults', () => {
    const result = SarahConfigSchema.parse({});
    expect(result.profile.postalCode).toBe('');
    expect(result.profile.birthday).toBe('');
    expect(result.profile.email).toBe('');
    expect(result.profile.linkPreferences).toEqual([]);
  });

  it('profile.birthday accepts ISO YYYY-MM-DD and empty string', () => {
    const withDate = SarahConfigSchema.parse({ profile: { birthday: '1990-03-15' } });
    expect(withDate.profile.birthday).toBe('1990-03-15');
    const empty = SarahConfigSchema.parse({ profile: { birthday: '' } });
    expect(empty.profile.birthday).toBe('');
  });

  it('profile.birthday rejects freeform text', () => {
    const result = SarahConfigSchema.safeParse({ profile: { birthday: 'gestern' } });
    expect(result.success).toBe(false);
  });

  it('linkPreferences entries get a generated id when missing', () => {
    const result = SarahConfigSchema.parse({
      profile: {
        linkPreferences: [{ description: 'Hotels', url: 'https://booking.com' }],
      },
    });
    expect(result.profile.linkPreferences).toHaveLength(1);
    expect(typeof result.profile.linkPreferences[0].id).toBe('string');
    expect(result.profile.linkPreferences[0].id.length).toBeGreaterThan(0);
  });

  it('linkPreferences entries preserve explicit id', () => {
    const result = SarahConfigSchema.parse({
      profile: {
        linkPreferences: [{ id: 'fixed-id', description: 'X', url: 'https://x' }],
      },
    });
    expect(result.profile.linkPreferences[0].id).toBe('fixed-id');
  });

  it('rejects a workerOptions.num_ctx below the response-reserve minimum', () => {
    const result = SarahConfigSchema.safeParse({ llm: { workerOptions: { num_ctx: 2048 } } });
    expect(result.success).toBe(false);
  });

  it('accepts a bounded remote Ollama endpoint without forcing loopback', () => {
    const result = SarahConfigSchema.parse({
      llm: { baseUrl: 'https://ollama.example.test:11434/api' },
    });

    expect(result.llm.baseUrl).toBe('https://ollama.example.test:11434/api');
  });

  it.each([
    { personalization: { speechRate: 0.1 } },
    { controls: { quietModeDuration: 0 } },
    { controls: { customCommands: [{ command: '/ok', prompt: 'x'.repeat(2_001) }] } },
    { controls: { customCommands: [{ command: 'not-a-command', prompt: 'ok' }] } },
    { llm: { baseUrl: 'file:///tmp/ollama.sock' } },
    { llm: { routerModel: 'x'.repeat(201) } },
    { llm: { options: { temperature: 2.1 } } },
    { llm: { options: { num_predict: 0 } } },
    { llm: { options: { num_ctx: 300_000 } } },
  ])('rejects unsafe config bounds: %#', (input) => {
    expect(SarahConfigSchema.safeParse(input).success).toBe(false);
  });

  it('normalizes and deduplicates bounded memory exclusion labels', () => {
    const result = SarahConfigSchema.parse({
      trust: { memoryExclusions: ['  Finanzen  ', 'finanzen', 'Projekt   Eule', 'Ｐｒｏｊｅｋｔ Eule'] },
    });

    expect(result.trust.memoryExclusions).toEqual(['Finanzen', 'Projekt Eule']);
  });

  it.each([
    { memoryExclusions: Array.from({ length: MAX_MEMORY_EXCLUSIONS + 1 }, (_, index) => `topic-${index}`) },
    { memoryExclusions: ['x'.repeat(MAX_MEMORY_EXCLUSION_LENGTH + 1)] },
  ])('rejects oversized memory exclusion input', ({ memoryExclusions }) => {
    expect(SarahConfigSchema.safeParse({ trust: { memoryExclusions } }).success).toBe(false);
  });
});
