// tests/services/llm/prompt-layers.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildCoreIdentity,
  buildCoreSafety,
  buildCoreUser,
  buildCoreSkills,
  buildCorePersonality,
  buildCoreTrust,
  buildCoreResponse,
  buildChatContext,
} from '../../../src/services/llm/prompt-layers';
import type { SarahConfig } from '../../../src/core/config-schema';

// Helper to create a full personalization config slice
function fullPersonalization(): SarahConfig['personalization'] {
  return {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1,
    chatFontSize: 'default',
    chatAlignment: 'stacked',
    emojisEnabled: true,
    responseMode: 'spontaneous',
    responseLanguage: 'de',
    responseStyle: 'mittel',
    tone: 'freundlich',
    characterTraits: ['Humorvoll', 'Sarkastisch'],
    quirk: 'pirat',
  };
}

describe('buildCoreIdentity', () => {
  it('returns identity block', () => {
    const result = buildCoreIdentity();
    expect(result).toContain('## IDENTITY');
    expect(result).toContain('Sarah');
  });
});

describe('buildCoreSafety', () => {
  it('returns safety rules', () => {
    const result = buildCoreSafety();
    expect(result).toContain('## SAFETY');
    expect(result).toContain('NEVER');
  });
});

describe('buildCoreUser', () => {
  it('includes all profile fields when present', () => {
    const profile: SarahConfig['profile'] = {
      displayName: 'Martin',
      lastName: '',
      city: 'Berlin',
      address: '',
      profession: 'Developer',
      activities: '',
      usagePurposes: ['Programmieren', 'Recherche'],
      hobbies: ['Gaming', 'Musik'],
    };
    const result = buildCoreUser(profile);
    expect(result).toContain('## USER');
    expect(result).toContain('Martin');
    expect(result).toContain('Berlin');
    expect(result).toContain('Developer');
    expect(result).toContain('Programmieren');
    expect(result).toContain('Gaming');
  });

  it('omits empty fields', () => {
    const profile: SarahConfig['profile'] = {
      displayName: 'Martin',
      lastName: '',
      city: '',
      address: '',
      profession: '',
      activities: '',
      usagePurposes: [],
      hobbies: [],
    };
    const result = buildCoreUser(profile);
    expect(result).toContain('Martin');
    expect(result).not.toContain('city');
    expect(result).not.toContain('profession');
    expect(result).not.toContain('purposes');
    expect(result).not.toContain('hobbies');
  });

  it('uses "User" when displayName is empty', () => {
    const profile: SarahConfig['profile'] = {
      displayName: '',
      lastName: '',
      city: '',
      address: '',
      profession: '',
      activities: '',
      usagePurposes: [],
      hobbies: [],
    };
    const result = buildCoreUser(profile);
    expect(result).toContain('name: User');
  });
});

describe('buildCoreSkills', () => {
  it('includes programming info when present', () => {
    const skills: SarahConfig['skills'] = {
      programming: 'fortgeschritten',
      programmingStack: ['TypeScript', 'React'],
      programmingResources: ['Stack Overflow'],
      programmingProjectsFolder: 'C:/dev',
      design: 'grundlagen',
      office: null,
    };
    const result = buildCoreSkills(skills);
    expect(result).toContain('## SKILLS');
    expect(result).toContain('fortgeschritten');
    expect(result).toContain('TypeScript');
    expect(result).toContain('C:/dev');
    expect(result).toContain('grundlagen');
    expect(result).not.toContain('office');
  });

  it('returns empty string when no skills set', () => {
    const skills: SarahConfig['skills'] = {
      programming: null,
      programmingStack: [],
      programmingResources: [],
      programmingProjectsFolder: '',
      design: null,
      office: null,
    };
    const result = buildCoreSkills(skills);
    expect(result).toBe('');
  });
});

describe('buildCorePersonality', () => {
  it('includes traits and quirk', () => {
    const pers = fullPersonalization();
    const result = buildCorePersonality(pers);
    expect(result).toContain('## PERSONALITY');
    expect(result).toContain('Humorvoll');
    expect(result).toContain('Sarkastisch');
    expect(result).toContain('pirat');
  });

  it('omits traits when empty', () => {
    const pers = fullPersonalization();
    pers.characterTraits = [];
    pers.quirk = null;
    const result = buildCorePersonality(pers);
    expect(result).not.toContain('traits');
    expect(result).not.toContain('quirk');
  });

  it('returns empty string when no traits and no quirk', () => {
    const pers = fullPersonalization();
    pers.characterTraits = [];
    pers.quirk = null;
    const result = buildCorePersonality(pers);
    expect(result).toBe('');
  });

  it('uses language-specific quirk examples for de', () => {
    const pers = fullPersonalization();
    pers.quirk = 'pirat';
    pers.responseLanguage = 'de';
    const result = buildCorePersonality(pers);
    expect(result).toContain('Landratten');
  });

  it('uses language-specific quirk examples for en', () => {
    const pers = fullPersonalization();
    pers.quirk = 'pirat';
    pers.responseLanguage = 'en';
    const result = buildCorePersonality(pers);
    expect(result).toContain('landlubbers');
  });

  it('passes custom quirk text through as-is', () => {
    const pers = fullPersonalization();
    pers.quirk = 'Sage immer Wunderbar!';
    const result = buildCorePersonality(pers);
    expect(result).toContain('quirk: Sage immer Wunderbar!');
  });
});

describe('buildCoreTrust', () => {
  it('includes confirmation level and exclusions', () => {
    const trust: SarahConfig['trust'] = {
      memoryAllowed: true,
      fileAccess: 'specific-folders',
      confirmationLevel: 'standard',
      memoryExclusions: ['Finanzen', 'Gesundheit'],
      anonymousEnabled: false,
      showContextEnabled: false,
    };
    const result = buildCoreTrust(trust);
    expect(result).toContain('## TRUST');
    expect(result).toContain('standard');
    expect(result).toContain('Finanzen');
  });

  it('omits blocked_topics when no exclusions', () => {
    const trust: SarahConfig['trust'] = {
      memoryAllowed: true,
      fileAccess: 'specific-folders',
      confirmationLevel: 'standard',
      memoryExclusions: [],
      anonymousEnabled: false,
      showContextEnabled: false,
    };
    const result = buildCoreTrust(trust);
    expect(result).not.toContain('blocked_topics');
  });
});

describe('buildCoreResponse', () => {
  it('includes response settings', () => {
    const pers = fullPersonalization();
    const result = buildCoreResponse(pers);
    expect(result).toContain('## RESPONSE');
    expect(result).toContain('response_language: de');
    expect(result).toContain('tone: friendly');
  });

  it('maps tone to english', () => {
    const pers = fullPersonalization();
    pers.tone = 'professionell';
    const result = buildCoreResponse(pers);
    expect(result).toContain('tone: professional');
  });

  it('includes mode instruction for spontaneous', () => {
    const pers = fullPersonalization();
    pers.responseMode = 'spontaneous';
    const result = buildCoreResponse(pers);
    expect(result).toContain('Get straight to the point');
  });

  it('omits mode instruction for normal', () => {
    const pers = fullPersonalization();
    pers.responseMode = 'normal';
    const result = buildCoreResponse(pers);
    expect(result).not.toContain('mode:');
  });

  it('includes style instruction for kurz', () => {
    const pers = fullPersonalization();
    pers.responseStyle = 'kurz';
    const result = buildCoreResponse(pers);
    expect(result).toContain('Be brief and concise');
  });

  it('includes English language instruction for en', () => {
    const pers = fullPersonalization();
    pers.responseLanguage = 'en';
    const result = buildCoreResponse(pers);
    expect(result).toContain('response_language: en');
    expect(result).toContain('always respond in English');
  });
});

describe('buildChatContext', () => {
  it('returns emoji allowed when emojis enabled', () => {
    const pers = fullPersonalization();
    pers.emojisEnabled = true;
    const result = buildChatContext(pers);
    expect(result).toContain('allowed: true');
    expect(result).toContain('sparingly');
  });

  it('returns emoji disallowed when emojis disabled', () => {
    const pers = fullPersonalization();
    pers.emojisEnabled = false;
    const result = buildChatContext(pers);
    expect(result).toContain('allowed: false');
  });
});
