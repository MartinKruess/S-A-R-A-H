import { z } from 'zod';
import { DEFAULT_LLM_CONFIG } from './llm-defaults.js';
import {
  MAX_MEMORY_EXCLUSIONS,
  MAX_MEMORY_EXCLUSION_LENGTH,
  normalizeMemoryExclusion,
  normalizeMemoryExclusions,
} from './memory-exclusions.js';

const pre = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => v ?? {}, schema);

// ── Sub-Schemas (individually exported for wizard/settings reuse) ──

export const LinkPreferenceSchema = z.object({
  id: z.string().default(() => crypto.randomUUID()),
  description: z.string().default(''),
  url: z.string().default(''),
});

export const ProfileSchema = z.object({
  displayName: z.string().default(''),
  lastName: z.string().default(''),
  city: z.string().default(''),
  address: z.string().default(''),
  postalCode: z.string().default(''),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default(''),
  email: z.string().default(''),
  profession: z.string().default(''),
  activities: z.string().default(''),
  usagePurposes: z.array(z.string()).default([]),
  hobbies: z.array(z.string()).default([]),
  linkPreferences: z.array(LinkPreferenceSchema).default([]),
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
  // Image name (e.g. "Spotify.exe") used to verify an appx launch via tasklist,
  // since explorer.exe's exit code is unreliable. Optional: unknown → no verify.
  processName: z.string().optional(),
});

export const PdfCategorySchema = z.object({
  tag: z.string(),
  folder: z.string(),
  pattern: z.string(),
  inferFromExisting: z.boolean(),
});

export const CustomCommandSchema = z.object({
  command: z.string().trim().regex(/^\/[a-z0-9_-]{1,50}$/iu),
  prompt: z.string().trim().min(1).max(2_000),
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

const MemoryExclusionSchema = z.string()
  .transform(normalizeMemoryExclusion)
  .pipe(z.string().min(1).max(MAX_MEMORY_EXCLUSION_LENGTH));

export const TrustSchema = z.object({
  memoryAllowed: z.boolean().default(true),
  webAccessAllowed: z.boolean().default(true),
  fileAccess: z.preprocess(
    (val) => (val === 'full' ? 'all' : val),
    z.enum(['specific-folders', 'all', 'none']).default('specific-folders'),
  ),
  confirmationLevel: z
    .enum(['minimal', 'standard', 'maximal'])
    .default('standard'),
  memoryExclusions: z.array(MemoryExclusionSchema)
    .max(MAX_MEMORY_EXCLUSIONS)
    .transform(normalizeMemoryExclusions)
    .default([]),
  anonymousEnabled: z.boolean().default(false),
  showContextEnabled: z.boolean().default(false),
});

export const PersonalizationSchema = z.object({
  accentColor: z.string().default('#00d4ff'),
  voice: z.string().default('default-female-de'),
  speechRate: z.number().min(0.5).max(2).default(1),
  chatFontSize: z.enum(['small', 'default', 'large']).default('default'),
  chatAlignment: z.enum(['stacked', 'bubbles']).default('stacked'),
  emojisEnabled: z.boolean().default(true),
  responseMode: z
    .enum(['normal', 'spontaneous', 'thoughtful'])
    .default('normal'),
  responseLanguage: z.enum(['de', 'en']).default('de'),
  responseStyle: z.enum(['kurz', 'mittel', 'ausführlich']).default('mittel'),
  tone: z
    .enum(['freundlich', 'professionell', 'locker', 'direkt'])
    .default('freundlich'),
  characterTraits: z.array(z.string()).default([]),
  quirk: z.string().nullable().default(null),
});

export const ControlsSchema = z.object({
  voiceMode: z.enum(['keyword', 'push-to-talk', 'off']).default('off'),
  pushToTalkKey: z.enum([
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
    'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]).default('F9'),
  quietModeDuration: z.number().int().min(1).max(24 * 60).default(30),
  customCommands: z.array(CustomCommandSchema).max(64).default([]),
});

export const AudioSchema = z.object({
  inputDeviceId: z.string().optional(),
  outputDeviceId: z.string().optional(),
  inputMuted: z.boolean().default(false),
  inputGain: z.number().min(0).max(1.5).default(1.0),
  inputVolume: z.number().min(0).max(1).default(1.0),
  outputVolume: z.number().min(0).max(1).default(1.0),
});

/**
 * Field-by-field equality check for AudioConfig. Used by the main-process
 * save-config handler to decide whether to emit `audio-config-changed`.
 * Prefer this over `JSON.stringify` diffs — avoids fragile key-ordering
 * coupling, and each field is typed so forgetting one at schema-extension
 * time is a type error, not a silent equality bug.
 */
export function isAudioConfigEqual(a: AudioConfig, b: AudioConfig): boolean {
  return (
    a.inputDeviceId === b.inputDeviceId &&
    a.outputDeviceId === b.outputDeviceId &&
    a.inputMuted === b.inputMuted &&
    a.inputGain === b.inputGain &&
    a.inputVolume === b.inputVolume &&
    a.outputVolume === b.outputVolume
  );
}

const OllamaBaseUrlSchema = z.string().trim().min(1).max(2_048).refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'Ollama-Adresse muss eine gültige HTTP(S)-URL sein');

const ModelNameSchema = z.string().trim().min(1).max(200);
const MAX_LLM_CONTEXT_TOKENS = 262_144;

export const LlmSchema = z.object({
  // Remote Ollama remains supported; only malformed/non-HTTP endpoints are rejected.
  baseUrl: OllamaBaseUrlSchema.default(DEFAULT_LLM_CONFIG.baseUrl),
  routerModel: ModelNameSchema.default(DEFAULT_LLM_CONFIG.routerModel),
  workerModel: ModelNameSchema.default(DEFAULT_LLM_CONFIG.workerModel),
  performanceProfile: z
    .enum(['leistung', 'schnell', 'normal', 'sparsam'])
    .default(DEFAULT_LLM_CONFIG.performanceProfile),
  workerOptions: z
    .object({
      // Floor = largest response reserve (NUM_PREDICT_MAP.ausführlich 3000 +
      // RESPONSE_SAFETY_TOKENS 256) plus headroom for system prompt + history (H3).
      num_ctx: z.number().int().min(4096).max(MAX_LLM_CONTEXT_TOKENS)
        .default(DEFAULT_LLM_CONFIG.workerOptions.num_ctx),
    })
    .default({ ...DEFAULT_LLM_CONFIG.workerOptions }),
  options: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      num_predict: z.number().int().min(1).max(16_384).optional(),
      num_ctx: z.number().int().min(4096).max(MAX_LLM_CONTEXT_TOKENS).optional(),
    })
    .default({ ...DEFAULT_LLM_CONFIG.options }),
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
  folders: pre(
    z.object({
      documents: z.string().default(''),
      downloads: z.string().default(''),
      pictures: z.string().default(''),
      desktop: z.string().default(''),
    }),
  ),
});

// ── Root Schema ──

export const SarahConfigSchema = z.preprocess(
  (raw) => {
    const obj = (raw ?? {}) as Record<string, Record<string, unknown>>;
    // Migrate responseStyle/tone from profile to personalization
    if (obj.profile && obj.personalization) {
      const p = obj.profile;
      const pers = obj.personalization;
      if (p.responseStyle && !pers.responseStyle) {
        pers.responseStyle = p.responseStyle;
        delete p.responseStyle;
      }
      if (p.tone && !pers.tone) {
        pers.tone = p.tone;
        delete p.tone;
      }
    }
    // Migrate llm.model → llm.workerModel (old single model was the worker)
    if (obj.llm && 'model' in obj.llm && !obj.llm.workerModel) {
      obj.llm.workerModel = obj.llm.model;
      delete obj.llm.model;
    }
    return obj;
  },
  z.object({
    onboarding: pre(z.object({
      setupComplete: z.boolean().default(false),
      firstStart: z.boolean().default(true),
    })),
    system: pre(SystemSchema),
    profile: pre(ProfileSchema),
    skills: pre(SkillsSchema),
    resources: pre(ResourcesSchema),
    trust: pre(TrustSchema),
    personalization: pre(PersonalizationSchema),
    controls: pre(ControlsSchema),
    audio: pre(AudioSchema),
    llm: pre(LlmSchema),
    integrations: pre(
      z.object({
        context7: z.boolean().default(false),
      }),
    ),
  }),
);

// ── Inferred Types ──

export type SarahConfig = z.infer<typeof SarahConfigSchema>;
type FlatSarahConfigPatch = {
  [Section in keyof SarahConfig]?: Partial<SarahConfig[Section]>;
};
export type SarahConfigPatch = Omit<FlatSarahConfigPatch, 'system' | 'llm'> & {
  system?: Partial<Omit<SarahConfig['system'], 'folders'>> & {
    folders?: Partial<SarahConfig['system']['folders']>;
  };
  llm?: Partial<Omit<SarahConfig['llm'], 'workerOptions' | 'options'>> & {
    workerOptions?: Partial<SarahConfig['llm']['workerOptions']>;
    options?: Partial<SarahConfig['llm']['options']>;
  };
};

/**
 * @param current - Vollstaendig validierter, aktuell aktiver Config-Snapshot.
 * @param patch - IPC-Teilupdate einer oder mehrerer Config-Sektionen.
 *
 * - Fuehrt jede Root-Sektion feldweise mit dem aktiven Snapshot zusammen.
 * - Fuehrt die verschachtelten System- und LLM-Optionen ebenfalls feldweise zusammen.
 * - Validiert und kanonisiert das Ergebnis vor Persistenz und Aktivierung.
 *
 * @returns Vollstaendige Config ohne Default-Reset durch fehlende Patch-Felder.
 *
 * @category Validation Transformation
 */
export function mergeSarahConfigPatch(
  current: SarahConfig,
  patch: SarahConfigPatch,
): SarahConfig {
  return SarahConfigSchema.parse({
    ...current,
    ...patch,
    onboarding: { ...current.onboarding, ...patch.onboarding },
    system: {
      ...current.system,
      ...patch.system,
      folders: { ...current.system.folders, ...patch.system?.folders },
    },
    profile: { ...current.profile, ...patch.profile },
    skills: { ...current.skills, ...patch.skills },
    resources: { ...current.resources, ...patch.resources },
    trust: { ...current.trust, ...patch.trust },
    personalization: { ...current.personalization, ...patch.personalization },
    controls: { ...current.controls, ...patch.controls },
    audio: { ...current.audio, ...patch.audio },
    llm: {
      ...current.llm,
      ...patch.llm,
      workerOptions: { ...current.llm.workerOptions, ...patch.llm?.workerOptions },
      options: { ...current.llm.options, ...patch.llm?.options },
    },
    integrations: { ...current.integrations, ...patch.integrations },
  });
}

export type Profile = z.infer<typeof ProfileSchema>;
export type LinkPreference = z.infer<typeof LinkPreferenceSchema>;
export type Skills = z.infer<typeof SkillsSchema>;
export type ProgramEntry = z.infer<typeof ProgramEntrySchema>;
export type PdfCategory = z.infer<typeof PdfCategorySchema>;
export type CustomCommand = z.infer<typeof CustomCommandSchema>;
export type Resources = z.infer<typeof ResourcesSchema>;
export type Trust = z.infer<typeof TrustSchema>;
export type Personalization = z.infer<typeof PersonalizationSchema>;
export type Controls = z.infer<typeof ControlsSchema>;
export type AudioConfig = z.infer<typeof AudioSchema>;
export type LlmConfig = z.infer<typeof LlmSchema>;
export type SystemInfo = z.infer<typeof SystemSchema>;
