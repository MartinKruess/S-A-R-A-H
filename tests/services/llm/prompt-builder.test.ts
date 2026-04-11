// tests/services/llm/prompt-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/services/llm/prompt-builder';
import type { SarahConfig } from '../../../src/core/config-schema';
import { SarahConfigSchema } from '../../../src/core/config-schema';

function createFullConfig(): SarahConfig {
  return SarahConfigSchema.parse({
    profile: {
      displayName: 'Martin',
      city: 'Berlin',
      profession: 'Developer',
      usagePurposes: ['Programmieren'],
      hobbies: ['Gaming'],
    },
    skills: {
      programming: 'fortgeschritten',
      programmingStack: ['TypeScript', 'React'],
    },
    personalization: {
      emojisEnabled: true,
      responseLanguage: 'de',
      responseStyle: 'mittel',
      tone: 'freundlich',
      responseMode: 'normal',
      characterTraits: ['Humorvoll'],
      quirk: 'pirat',
    },
    trust: {
      confirmationLevel: 'standard',
      memoryExclusions: ['Finanzen'],
    },
  });
}

describe('buildSystemPrompt', () => {
  it('assembles all sections in chat mode', () => {
    const config = createFullConfig();
    const prompt = buildSystemPrompt(config, 'chat');

    expect(prompt).toContain('Sarah');
    expect(prompt).toContain('Martin');
    expect(prompt).toContain('Berlin');
    expect(prompt).toContain('fortgeschritten');
    expect(prompt).toContain('Humorvoll');
    expect(prompt).toContain('German');
    expect(prompt).toContain('friendly');
  });

  it('allows emojis in chat mode when enabled', () => {
    const config = createFullConfig();
    config.personalization.emojisEnabled = true;
    const prompt = buildSystemPrompt(config, 'chat');
    expect(prompt).toContain('1-2 emojis');
  });

  it('forbids emojis in chat mode when disabled', () => {
    const config = createFullConfig();
    config.personalization.emojisEnabled = false;
    const prompt = buildSystemPrompt(config, 'chat');
    expect(prompt).toContain('Do NOT use any emojis');
    expect(prompt).toContain('Zero emojis');
  });

  it('always forbids emojis and formatting in voice mode', () => {
    const config = createFullConfig();
    config.personalization.emojisEnabled = true;
    const prompt = buildSystemPrompt(config, 'voice');
    expect(prompt).toContain('Do NOT use any emojis');
    expect(prompt).toContain('Do NOT use asterisks');
    expect(prompt).toContain('voice conversation');
  });

  it('never contains null values', () => {
    const config = createFullConfig();
    config.skills.design = null;
    config.skills.office = null;
    config.personalization.quirk = null;
    const prompt = buildSystemPrompt(config, 'chat');
    expect(prompt).not.toContain('null');
  });

  it('omits empty sections', () => {
    const config = SarahConfigSchema.parse({});
    const prompt = buildSystemPrompt(config, 'chat');
    // Skills section should be omitted with default empty config
    expect(prompt).not.toContain('programming level');
    // Personality section should be omitted (no traits, no quirk)
    expect(prompt).not.toContain('personality traits');
  });

  it('is written in English', () => {
    const config = createFullConfig();
    const prompt = buildSystemPrompt(config, 'chat');
    // Should not contain German prose instructions
    expect(prompt).not.toContain('Du bist');
    expect(prompt).not.toContain('Antworte');
    expect(prompt).not.toContain('Verwende keine');
  });

  it('contains user data like city name as-is', () => {
    const config = createFullConfig();
    const prompt = buildSystemPrompt(config, 'chat');
    expect(prompt).toContain('Berlin');
    expect(prompt).toContain('Martin');
  });
});
