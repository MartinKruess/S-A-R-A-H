import * as path from 'path';
import { MessageBus } from './message-bus.js';
import { ServiceRegistry } from './service-registry.js';
import { JsonStorage } from './storage/json-storage.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { EncryptedStorage } from './storage/encrypted-storage.js';
import { KeyManager, type KeyManagerOptions } from './crypto/key-manager.js';
import type { StorageProvider } from './storage/storage.interface.js';
import { SarahConfigSchema } from './config-schema.js';
import type { SarahConfig } from './config-schema.js';
import { AppLifecycleController } from './app-lifecycle-controller.js';
import { ActionConfirmationGate } from './action-confirmation.js';
import { removeReservedCustomCommandCollisions } from '../services/commands/builtin-commands.js';

export interface AppContext {
  bus: MessageBus;
  registry: ServiceRegistry;
  lifecycle: AppLifecycleController;
  config: StorageProvider;
  db: StorageProvider;
  /** Validated and defaulted config snapshot. Re-read after save-config. */
  parsedConfig: SarahConfig;
  /** Shared one-time authorization boundary for state-changing actions. */
  actionConfirmations: ActionConfirmationGate;
  /** Non-null if config validation failed — caller should show dialog */
  configErrors: string[] | null;
  /** Prevents a recovery-generated memoryAllowed=false from deleting retained Layer-2 data. */
  memoryRecoveryGuardActive: boolean;
  shutdown: () => Promise<void>;
}

export const MEMORY_RECOVERY_GUARD_KEY = 'layer2MemoryRecoveryGuard';

const FAIL_CLOSED_TRUST = {
  memoryAllowed: false,
  webAccessAllowed: false,
  fileAccess: 'none' as const,
  confirmationLevel: 'maximal' as const,
  anonymousEnabled: false,
  showContextEnabled: false,
};

interface ConfigRecovery {
  config: SarahConfig;
  errors: string[];
}

/**
 * Repairs only invalid config fields while retaining independently valid data.
 * Invalid trust fields fall back to restrictive values instead of permissive defaults.
 */
export function recoverInvalidConfigSnapshot(
  raw: Record<string, unknown>,
  forceFailClosedTrust = false,
): ConfigRecovery {
  const defaults = SarahConfigSchema.parse({});
  const candidate = structuredClone(raw);
  const initial = SarahConfigSchema.safeParse(structuredClone(candidate));
  const errors = initial.success
    ? []
    : initial.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  const repairNotes: string[] = [];

  if (initial.success && !forceFailClosedTrust) {
    return { config: initial.data, errors };
  }

  if (forceFailClosedTrust) {
    candidate.trust = {
      ...(isRecord(candidate.trust) ? candidate.trust : {}),
      ...FAIL_CLOSED_TRUST,
    };
  }

  // A program inventory can legitimately contain hundreds of independently
  // invalid legacy entries. Bound work against hostile input, but never turn an
  // exhausted repair budget into a silent replacement of the whole profile.
  const repairBudget = Math.max(1_000, countConfigNodes(candidate) * 2);
  for (let attempt = 0; attempt < repairBudget; attempt += 1) {
    const parsed = SarahConfigSchema.safeParse(structuredClone(candidate));
    if (parsed.success) return { config: parsed.data, errors: [...errors, ...repairNotes] };

    const issuePath = parsed.error.issues[0].path.filter(
      (part): part is string | number => typeof part === 'string' || typeof part === 'number',
    );
    const changed = repairConfigPath(candidate, defaults, issuePath);
    if (!changed) break;
    const repairedPath = issuePath.join('.') || 'Konfigurationswurzel';
    const repairNote = issuePath[0] === 'trust' && issuePath[1] === 'memoryExclusions'
      ? 'Repariert: trust.memoryExclusions wurde geleert und Erinnerungen wurden vorsorglich deaktiviert.'
      : issuePath.some((part) => typeof part === 'number')
        ? `Repariert: Ungültiger Listeneintrag ${repairedPath} wurde entfernt.`
        : `Repariert: ${repairedPath} wurde auf einen sicheren Standardwert gesetzt.`;
    if (!repairNotes.includes(repairNote)) {
      repairNotes.push(repairNote);
    }
  }

  throw new Error(
    'Die Konfiguration konnte nicht verlustfrei repariert werden. Die Originaldaten wurden nicht ersetzt.',
  );
}

function countConfigNodes(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1;
  return 1 + Object.values(value).reduce((count, child) => count + countConfigNodes(child), 0);
}

/**
 * Bootstrap the S.A.R.A.H. application.
 * Creates and wires up all core infrastructure.
 * Validates the config with Zod — returns defaults on invalid config.
 *
 * @param userDataPath — Electron's app.getPath('userData') or a test directory
 */
export async function bootstrap(
  userDataPath: string,
  keyManagerOptions: KeyManagerOptions = {},
): Promise<AppContext> {
  let config: EncryptedStorage | null = null;
  let db: EncryptedStorage | null = null;

  try {
    const keyManager = new KeyManager(userDataPath, keyManagerOptions);
    const encryptionKey = keyManager.getOrCreateKey();

    const bus = new MessageBus();
    const registry = new ServiceRegistry(bus);
    const lifecycle = new AppLifecycleController(registry);
    const actionConfirmations = new ActionConfirmationGate();
    const reportStorageIntegrity = (failure: { location: string }): void => {
      lifecycle.setCapability(
        'storage',
        'degraded',
        `Ein beschädigter verschlüsselter Wert wurde isoliert (${failure.location}).`,
      );
    };

    const rawConfig = new JsonStorage(path.join(userDataPath, 'config.json'));
    config = new EncryptedStorage(rawConfig, encryptionKey, { onIntegrityFailure: reportStorageIntegrity });
    let databaseError: string | null = null;
    let rawDb: SqliteStorage;
    try {
      rawDb = new SqliteStorage(path.join(userDataPath, 'sarah.db'));
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
      console.error('[Bootstrap] Database unavailable; using volatile storage for this run:', error);
      // Preserve the original database untouched. A process-local SQLite store
      // keeps chat usable while the capability truthfully reports that nothing
      // from this run survives a restart.
      rawDb = new SqliteStorage(':memory:');
    }
    db = new EncryptedStorage(rawDb, encryptionKey, { onIntegrityFailure: reportStorageIntegrity });

    // Validate config — safeParse so caller can handle errors gracefully
    let raw: Record<string, unknown> = {};
    const storageErrors: string[] = [];
    let forceFailClosedTrust = false;
    try {
      const legacyRootMigrated = await config.migrateLegacyConfigValue('root', (value) => {
        if (!isRecord(value)) throw new Error('Legacy config root is not an object');
        return value;
      });
      if (legacyRootMigrated) {
        // V1 proves authenticity, but not which config key originally owned the
        // ciphertext. Keep the data for review while applying restrictive trust
        // until the user accepts the repaired, now position-bound snapshot.
        forceFailClosedTrust = true;
        storageErrors.push(
          'Eine alte, nicht positionsgebundene Konfiguration wurde sicher migriert. Die Vertrauenseinstellungen müssen einmal bestätigt werden.',
        );
      }
    } catch (error) {
      forceFailClosedTrust = true;
      storageErrors.push(
        `Legacy-Konfiguration konnte nicht sicher migriert werden: ${error instanceof Error ? error.message : 'unbekannter Fehler'}`,
      );
    }
    try {
      const storedRoot = await config.get<Record<string, unknown>>('root');
      raw = storedRoot ?? {};
      if (storedRoot === undefined && rawConfig.hasPersistedSnapshot()) {
        forceFailClosedTrust = true;
        storageErrors.push('Die persistierte Konfiguration enthält keinen lesbaren root-Wert.');
      }
    } catch (error) {
      forceFailClosedTrust = true;
      storageErrors.push(`Verschlüsselte Konfiguration ist nicht lesbar: ${error instanceof Error ? error.message : 'unbekannter Fehler'}`);
    }
    // EncryptedStorage may only discover ciphertext corruption while reading and
    // call recoverLastValidSnapshot() here. Evaluate the recovery state after
    // that read so an older valid snapshot can never relax trust boundaries.
    forceFailClosedTrust ||= rawConfig.requiresFailClosedDefaults()
      || rawConfig.getRecoveryIssues().length > 0;
    storageErrors.push(...rawConfig.getRecoveryIssues());
    let persistedRecoveryGuard = false;
    try {
      await config.migrateLegacyConfigValue(MEMORY_RECOVERY_GUARD_KEY, (value) => {
        if (value !== true) throw new Error('Legacy recovery guard is not the expected enabled marker');
        return true;
      });
      persistedRecoveryGuard = await config.get<boolean>(MEMORY_RECOVERY_GUARD_KEY) === true;
    } catch (error) {
      forceFailClosedTrust = true;
      storageErrors.push(
        `Persistierter Memory-Recovery-Schutz ist nicht lesbar: ${error instanceof Error ? error.message : 'unbekannter Fehler'}`,
      );
    }
    const recovery = recoverInvalidConfigSnapshot(raw, forceFailClosedTrust);
    const rawTrust = isRecord(raw.trust) ? raw.trust : null;
    const recoveryDisabledMemory = forceFailClosedTrust
      || (recovery.config.trust.memoryAllowed === false && rawTrust?.memoryAllowed !== false);

    let parsedConfig = recovery.config;
    const allConfigErrors = [...storageErrors, ...recovery.errors];
    let configErrors: string[] | null = allConfigErrors.length > 0 ? allConfigErrors : null;
    {
      const customCommands = removeReservedCustomCommandCollisions(
        parsedConfig.controls.customCommands,
      );
      if (customCommands.length !== parsedConfig.controls.customCommands.length) {
        parsedConfig = {
          ...parsedConfig,
          controls: { ...parsedConfig.controls, customCommands },
        };
        const rawControls = raw.controls && typeof raw.controls === 'object'
          ? raw.controls as Record<string, unknown>
          : {};
        if (!configErrors) {
          try {
            await config.set('root', {
              ...raw,
              controls: { ...rawControls, customCommands },
            });
          } catch (error) {
            console.warn('[Bootstrap] Reserved custom-command cleanup could not be persisted:', error);
          }
        }
      }
    }
    if (configErrors) {
      console.error('[Bootstrap] Config validation/recovery required:', configErrors);
    }

    lifecycle.setCapability(
      'storage',
      databaseError || configErrors || config.getIntegrityFailures().length > 0 || db.getIntegrityFailures().length > 0
        ? 'degraded'
        : 'ready',
      configErrors
        ? 'Die Konfiguration wurde sicher eingeschränkt und muss bestätigt repariert werden.'
        : databaseError
          ? 'Die Datenbank ist nicht verfügbar. Neue Unterhaltungen bleiben nur bis zum Neustart erhalten.'
          : undefined,
    );
    lifecycle.registerCleanup('database', () => db!.close());
    lifecycle.registerCleanup('config', () => config!.close());

    return {
      bus,
      registry,
      lifecycle,
      config,
      db,
      parsedConfig,
      actionConfirmations,
      configErrors,
      memoryRecoveryGuardActive: persistedRecoveryGuard || recoveryDisabledMemory,
      shutdown: async () => { await lifecycle.shutdown(); },
    };
  } catch (error) {
    await Promise.allSettled([
      db?.close(),
      config?.close(),
    ]);
    throw error;
  }
}

/** Persist the validated default snapshot after the user accepts config repair. */
export async function repairInvalidConfig(context: AppContext): Promise<void> {
  if (!context.configErrors) return;
  // Write the guard first: a crash between these two durable writes may retain
  // data unnecessarily, but can never leave a recovery-generated false policy
  // able to erase Layer-2 data on the next boot.
  if (context.memoryRecoveryGuardActive) {
    await context.config.set(MEMORY_RECOVERY_GUARD_KEY, true);
  }
  await context.config.set('root', context.parsedConfig);
  context.configErrors = null;
}

function repairConfigPath(
  candidate: Record<string, unknown>,
  defaults: SarahConfig,
  issuePath: readonly (string | number)[],
): boolean {
  if (issuePath.length === 0) return false;

  if (issuePath[0] === 'trust') {
    const trust = isRecord(candidate.trust) ? candidate.trust : {};
    if (issuePath.length === 1) {
      candidate.trust = { ...trust, ...FAIL_CLOSED_TRUST };
      return true;
    }
    const field = issuePath[1];
    if (
      field === 'memoryAllowed'
      || field === 'webAccessAllowed'
      || field === 'fileAccess'
      || field === 'confirmationLevel'
    ) {
      trust[field] = FAIL_CLOSED_TRUST[field];
      candidate.trust = trust;
      return true;
    }
    if (field === 'memoryExclusions') {
      // Unknown exclusion semantics must not be repaired to an empty,
      // permissive list while persistence remains enabled.
      trust.memoryAllowed = false;
      trust.memoryExclusions = [];
      candidate.trust = trust;
      return true;
    }
  }

  const numericIndex = issuePath.findIndex((part) => typeof part === 'number');
  if (numericIndex >= 0) {
    const arrayPath = issuePath.slice(0, numericIndex);
    const array = readPath(candidate, arrayPath);
    const itemIndex = issuePath[numericIndex];
    if (Array.isArray(array) && typeof itemIndex === 'number' && itemIndex >= 0 && itemIndex < array.length) {
      array.splice(itemIndex, 1);
      return true;
    }
  }

  const defaultValue = readPath(defaults as Record<string, unknown>, issuePath);
  return writePath(candidate, issuePath, defaultValue);
}

function readPath(root: Record<string, unknown>, valuePath: readonly (string | number)[]): unknown {
  let current: object | null = root;
  for (let index = 0; index < valuePath.length; index += 1) {
    const part = valuePath[index];
    if (current === null || !(part in current)) return undefined;
    const value: unknown = (current as Record<string | number, unknown>)[part];
    if (index === valuePath.length - 1) return value;
    current = value !== null && typeof value === 'object' ? value : null;
  }
  return current;
}

function writePath(
  root: Record<string, unknown>,
  valuePath: readonly (string | number)[],
  value: unknown,
): boolean {
  let current: Record<string | number, unknown> = root;
  for (let index = 0; index < valuePath.length - 1; index += 1) {
    const part = valuePath[index];
    const next = current[part];
    if (next === null || typeof next !== 'object') return false;
    current = next as Record<string | number, unknown>;
  }
  const leaf = valuePath[valuePath.length - 1];
  if (value === undefined) delete current[leaf];
  else current[leaf] = structuredClone(value);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}
