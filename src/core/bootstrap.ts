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
  shutdown: () => Promise<void>;
}

const FAIL_CLOSED_TRUST = {
  memoryAllowed: false,
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

  if (initial.success && !forceFailClosedTrust) {
    return { config: initial.data, errors };
  }

  if (forceFailClosedTrust) {
    candidate.trust = {
      ...(isRecord(candidate.trust) ? candidate.trust : {}),
      ...FAIL_CLOSED_TRUST,
    };
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const parsed = SarahConfigSchema.safeParse(structuredClone(candidate));
    if (parsed.success) return { config: parsed.data, errors };

    const issuePath = parsed.error.issues[0].path.filter(
      (part): part is string | number => typeof part === 'string' || typeof part === 'number',
    );
    const changed = repairConfigPath(candidate, defaults, issuePath);
    if (!changed) break;
  }

  return {
    config: {
      ...defaults,
      trust: { ...defaults.trust, ...FAIL_CLOSED_TRUST },
    },
    errors,
  };
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
    const rawDb = new SqliteStorage(path.join(userDataPath, 'sarah.db'));
    db = new EncryptedStorage(rawDb, encryptionKey, { onIntegrityFailure: reportStorageIntegrity });

    // Validate config — safeParse so caller can handle errors gracefully
    let raw: Record<string, unknown> = {};
    const storageErrors: string[] = [];
    let forceFailClosedTrust = false;
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
    const recovery = recoverInvalidConfigSnapshot(raw, forceFailClosedTrust);

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
      configErrors || config.getIntegrityFailures().length > 0 || db.getIntegrityFailures().length > 0
        ? 'degraded'
        : 'ready',
      configErrors ? 'Die Konfiguration wurde sicher eingeschränkt und muss bestätigt repariert werden.' : undefined,
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
    if (field === 'memoryAllowed' || field === 'fileAccess' || field === 'confirmationLevel') {
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
