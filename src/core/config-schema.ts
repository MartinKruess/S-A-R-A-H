import { z } from 'zod';

const pre = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => v ?? {}, schema);

// ── Sub-Schemas (individually exported for wizard/settings reuse) ──

export const ProfileSchema = z.object({
  displayName: z.string().default(''),
  lastName: z.string().default(''),
  city: z.string().default(''),
  address: z.string().default(''),
  profession: z.string().default(''),
  activities: z.string().default(''),
  usagePurposes: z.array(z.string()).default([]),
  hobbies: z.array(z.string()).default([]),
  responseStyle: z.enum(['kurz', 'mittel', 'ausführlich']).default('mittel'),
  tone: z.enum(['freundlich', 'professionell', 'locker', 'direkt']).default('freundlich'),
});

export const SkillsSchema = z.object({
  programming: z.string().nullable().default(null),
  programmingStack: z.array(z.string()).default([]),
  programmingResources: z.array(z.string()).default([]),
  programmingProjectsFolder: z.string().default(''),
  design: z.string().nullable().default(null),
  office: z.string().nullable().default(null),
});

export const ProgramEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['exe', 'launcher', 'appx', 'updater']),
  source: z.enum(['detected', 'manual', 'learned']),
  verified: z.boolean(),
  aliases: z.array(z.string()),
  duplicateGroup: z.string().optional(),
});

export const PdfCategorySchema = z.object({
  tag: z.string(),
  folder: z.string(),
  pattern: z.string(),
  inferFromExisting: z.boolean(),
});

export const CustomCommandSchema = z.object({
  command: z.string(),
  prompt: z.string(),
});

export const ResourcesSchema = z.object({
  emails: z.array(z.string()).default([]),
  programs: z.array(ProgramEntrySchema).default([]),
  favoriteLinks: z.array(z.string()).default([]),
  pdfCategories: z.array(PdfCategorySchema).default([]),
  picturesFolder: z.string().default(''),
  installFolder: z.string().default(''),
  gamesFolder: z.string().default(''),
  extraProgramsFolder: z.string().default(''),
  importantFolders: z.array(z.string()).default([]),
});

export const TrustSchema = z.object({
  memoryAllowed: z.boolean().default(true),
  fileAccess: z.preprocess(
    (val) => val === 'full' ? 'all' : val,
    z.enum(['specific-folders', 'all', 'none']).default('specific-folders'),
  ),
  confirmationLevel: z.enum(['minimal', 'standard', 'maximal']).default('standard'),
  memoryExclusions: z.array(z.string()).default([]),
  anonymousEnabled: z.boolean().default(false),
  showContextEnabled: z.boolean().default(false),
});

export const PersonalizationSchema = z.object({
  accentColor: z.string().default('#00d4ff'),
  voice: z.string().default('default-female-de'),
  speechRate: z.number().default(1),
  chatFontSize: z.enum(['small', 'default', 'large']).default('default'),
  chatAlignment: z.enum(['stacked', 'bubbles']).default('stacked'),
  emojisEnabled: z.boolean().default(true),
  responseMode: z.enum(['normal', 'spontaneous', 'thoughtful']).default('normal'),
  characterTraits: z.array(z.string()).default([]),
  quirk: z.string().nullable().default(null),
});

export const ControlsSchema = z.object({
  voiceMode: z.enum(['keyword', 'push-to-talk', 'off']).default('off'),
  pushToTalkKey: z.string().default('F9'),
  quietModeDuration: z.number().default(30),
  customCommands: z.array(CustomCommandSchema).default([]),
});

export const LlmSchema = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  model: z.string().default('qwen3.5:4b'),
  options: z.object({
    temperature: z.number().optional(),
    num_predict: z.number().optional(),
    num_ctx: z.number().optional(),
  }).default({}),
});

export const SystemSchema = z.object({
  os: z.string().default(''),
  platform: z.string().default(''),
  arch: z.string().default(''),
  cpu: z.string().default(''),
  cpuCores: z.string().default(''),
  totalMemory: z.string().default(''),
  freeMemory: z.string().default(''),
  hostname: z.string().default(''),
  shell: z.string().default(''),
  language: z.string().default(''),
  timezone: z.string().default(''),
  folders: pre(z.object({
    documents: z.string().default(''),
    downloads: z.string().default(''),
    pictures: z.string().default(''),
    desktop: z.string().default(''),
  })),
});

// ── Root Schema ──

export const SarahConfigSchema = z.object({
  onboarding: pre(z.object({ setupComplete: z.boolean().default(false) })),
  system: pre(SystemSchema),
  profile: pre(ProfileSchema),
  skills: pre(SkillsSchema),
  resources: pre(ResourcesSchema),
  trust: pre(TrustSchema),
  personalization: pre(PersonalizationSchema),
  controls: pre(ControlsSchema),
  llm: pre(LlmSchema),
  integrations: pre(z.object({
    context7: z.boolean().default(false),
  })),
});

// ── Inferred Types ──

export type SarahConfig = z.infer<typeof SarahConfigSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Skills = z.infer<typeof SkillsSchema>;
export type ProgramEntry = z.infer<typeof ProgramEntrySchema>;
export type PdfCategory = z.infer<typeof PdfCategorySchema>;
export type CustomCommand = z.infer<typeof CustomCommandSchema>;
export type Resources = z.infer<typeof ResourcesSchema>;
export type Trust = z.infer<typeof TrustSchema>;
export type Personalization = z.infer<typeof PersonalizationSchema>;
export type Controls = z.infer<typeof ControlsSchema>;
export type LlmConfig = z.infer<typeof LlmSchema>;
export type SystemInfo = z.infer<typeof SystemSchema>;
