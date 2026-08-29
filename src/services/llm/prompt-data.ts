export type PromptDataKind =
  | 'authoritative_user_profile'
  | 'preferred_sources'
  | 'user_skill_data'
  | 'personality_data'
  | 'custom_quirk_data'
  | 'memory_exclusion_data'
  | 'external_search_data'
  | 'local_program_data'
  | 'recalled_memory_data';

export type PromptDataValue =
  | string
  | number
  | boolean
  | null
  | readonly PromptDataValue[]
  | { readonly [key: string]: PromptDataValue };

/**
 * Serializes untrusted prompt data into one length-bounded grammar line.
 *
 * - Keeps newlines and quote characters inside JSON string syntax.
 * - Avoids open/close block markers that user-controlled values can imitate.
 * - Leaves the trust instruction outside the serialized payload.
 *
 * @returns A single `SARAH_DATA` record for the model context.
 *
 * @category Transformation Validation
 */
export function serializePromptData(kind: PromptDataKind, value: PromptDataValue): string {
  return `SARAH_DATA ${kind} ${JSON.stringify(value)}`;
}
