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
  buildVoiceContext,
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
  it('returns identity with Sarah name', () => {
    const result = buildCoreIdentity();
    expect(result).toContain('Sarah');
    expect(result).toContain('assistant');
  });

  it('includes no-markdown rule', () => {
    const result = buildCoreIdentity();
    expect(result).toContain('Do NOT use markdown');
  });

  it('includes no-name-repetition rule', () => {
    const result = buildCoreIdentity();
    expect(result).toContain('Do NOT say the user');
    expect(result).toContain('name');
  });
});

describe('buildCoreSafety', () => {
  it('returns safety rules', () => {
    const result = buildCoreSafety();
    expect(result).toContain('Never');
    expect(result).toContain('instructions');
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
    expect(result).not.toContain('Berlin');
    expect(result).not.toContain('Developer');
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
    expect(result).toContain('User');
  });

  it('tells model to only use info when relevant', () => {
    const profile: SarahConfig['profile'] = {
      displayName: 'Martin',
      lastName: '',
      city: '',
      address: '',
      profession: 'Developer',
      activities: '',
      usagePurposes: [],
      hobbies: ['Gaming'],
    };
    const result = buildCoreUser(profile);
    expect(result).toContain('only when relevant');
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
    expect(result).toContain('fortgeschritten');
    expect(result).toContain('TypeScript');
    expect(result).toContain('C:/dev');
    expect(result).toContain('grundlagen');
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

  it('tells model to only mention skills when asked', () => {
    const skills: SarahConfig['skills'] = {
      programming: 'fortgeschritten',
      programmingStack: [],
      programmingResources: [],
      programmingProjectsFolder: '',
      design: null,
      office: null,
    };
    const result = buildCoreSkills(skills);
    expect(result).toContain('Only mention');
  });
});

describe('buildCorePersonality', () => {
  it('includes traits and quirk', () => {
    const pers = fullPersonalization();
    const result = buildCorePersonality(pers);
    expect(result).toContain('Humorvoll');
    expect(result).toContain('Sarkastisch');
    expect(result).toContain('pirate');
  });

  it('returns empty string when no traits and no quirk', () => {
    const pers = fullPersonalization();
    pers.characterTraits = [];
    pers.quirk = null;
    const result = buildCorePersonality(pers);
    expect(result).toBe('');
  });

  it('uses language-specific quirk for de', () => {
    const pers = fullPersonalization();
    pers.quirk = 'pirat';
    pers.responseLanguage = 'de';
    const result = buildCorePersonality(pers);
    expect(result).toContain('Landratten');
  });

  it('uses language-specific quirk for en', () => {
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
    expect(result).toContain('Sage immer Wunderbar!');
  });

  it('tells model to show traits subtly', () => {
    const pers = fullPersonalization();
    const result = buildCorePersonality(pers);
    expect(result).toContain('subtly');
  });
});

describe('buildCoreTrust', () => {
  it('includes confirmation instruction', () => {
    const trust: SarahConfig['trust'] = {
      memoryAllowed: true,
      fileAccess: 'specific-folders',
      confirmationLevel: 'standard',
      memoryExclusions: ['Finanzen', 'Gesundheit'],
      anonymousEnabled: false,
      showContextEnabled: false,
    };
    const result = buildCoreTrust(trust);
    expect(result).toContain('Ask before');
    expect(result).toContain('Finanzen');
  });

  it('omits exclusions when empty', () => {
    const trust: SarahConfig['trust'] = {
      memoryAllowed: true,
      fileAccess: 'specific-folders',
      confirmationLevel: 'standard',
      memoryExclusions: [],
      anonymousEnabled: false,
      showContextEnabled: false,
    };
    const result = buildCoreTrust(trust);
    expect(result).not.toContain('Never store');
  });
});

describe('buildCoreResponse', () => {
  it('includes German language instruction for de', () => {
    const pers = fullPersonalization();
    const result = buildCoreResponse(pers);
    expect(result).toContain('German');
    expect(result).toContain('MUST');
  });

  it('includes English language instruction for en', () => {
    const pers = fullPersonalization();
    pers.responseLanguage = 'en';
    const result = buildCoreResponse(pers);
    expect(result).toContain('English');
    expect(result).toContain('MUST');
  });

  it('maps tone to english', () => {
    const pers = fullPersonalization();
    pers.tone = 'professionell';
    const result = buildCoreResponse(pers);
    expect(result).toContain('professional');
  });

  it('includes mode instruction for spontaneous', () => {
    const pers = fullPersonalization();
    pers.responseMode = 'spontaneous';
    const result = buildCoreResponse(pers);
    expect(result).toContain('straight to the point');
  });

  it('omits mode instruction for normal', () => {
    const pers = fullPersonalization();
    pers.responseMode = 'normal';
    const result = buildCoreResponse(pers);
    expect(result).not.toContain('straight to the point');
    expect(result).not.toContain('step by step');
  });

  it('includes style instruction for kurz', () => {
    const pers = fullPersonalization();
    pers.responseStyle = 'kurz';
    const result = buildCoreResponse(pers);
    expect(result).toContain('1-3 sentences');
    expect(result).toContain('IMPORTANT');
  });
});

describe('buildChatContext', () => {
  it('allows limited emojis when enabled', () => {
    const pers = fullPersonalization();
    pers.emojisEnabled = true;
    const result = buildChatContext(pers);
    expect(result).toContain('1-2 emojis');
  });

  it('forbids emojis when disabled', () => {
    const pers = fullPersonalization();
    pers.emojisEnabled = false;
    const result = buildChatContext(pers);
    expect(result).toContain('Do NOT use any emojis');
  });
});

describe('buildVoiceContext', () => {
  it('forbids emojis and formatting for voice', () => {
    const result = buildVoiceContext();
    expect(result).toContain('Do NOT use any emojis');
    expect(result).toContain('Do NOT use asterisks');
    expect(result).toContain('voice conversation');
  });
});
