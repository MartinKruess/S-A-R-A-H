// src/services/llm/prompt-builder.ts
import type { SarahConfig } from '../../core/config-schema.js';
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
} from './prompt-layers.js';

export function buildSystemPrompt(
  config: SarahConfig,
  mode: 'chat' | 'voice',
): string {
  const { profile, skills, personalization, trust } = config;

  const sections: string[] = [
    buildCoreIdentity(),
    buildCoreSafety(),
    buildCoreUser(profile),
    buildCoreSkills(skills),
    buildCorePersonality(personalization),
    buildCoreTrust(trust),
    buildCoreResponse(personalization),
  ];

  // Context layer: mode-specific rules
  if (mode === 'voice') {
    sections.push(buildVoiceContext());
  } else {
    sections.push(buildChatContext(personalization));
  }

  return sections.filter(Boolean).join('\n\n');
}
