import * as path from 'path';
import { MessageBus } from './message-bus.js';
import { ServiceRegistry } from './service-registry.js';
import { JsonStorage } from './storage/json-storage.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { EncryptedStorage } from './storage/encrypted-storage.js';
import { KeyManager } from './crypto/key-manager.js';
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

/**
 * Bootstrap the S.A.R.A.H. application.
 * Creates and wires up all core infrastructure.
 * Validates the config with Zod — returns defaults on invalid config.
 *
 * @param userDataPath — Electron's app.getPath('userData') or a test directory
 */
export async function bootstrap(userDataPath: string): Promise<AppContext> {
  let config: EncryptedStorage | null = null;
  let db: EncryptedStorage | null = null;

  try {
    const keyManager = new KeyManager(userDataPath);
    const encryptionKey = keyManager.getOrCreateKey();

    const bus = new MessageBus();
    const registry = new ServiceRegistry(bus);
    const lifecycle = new AppLifecycleController(registry);
    const actionConfirmations = new ActionConfirmationGate();

    const rawConfig = new JsonStorage(path.join(userDataPath, 'config.json'));
    config = new EncryptedStorage(rawConfig, encryptionKey);
    const rawDb = new SqliteStorage(path.join(userDataPath, 'sarah.db'));
    db = new EncryptedStorage(rawDb, encryptionKey);

    // Validate config — safeParse so caller can handle errors gracefully
    const raw = (await config.get<Record<string, unknown>>('root')) ?? {};
    const parseResult = SarahConfigSchema.safeParse(raw);

    let parsedConfig: SarahConfig;
    let configErrors: string[] | null = null;
    if (parseResult.success) {
      parsedConfig = parseResult.data;
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
        try {
          await config.set('root', {
            ...raw,
            controls: { ...rawControls, customCommands },
          });
        } catch (error) {
          console.warn('[Bootstrap] Reserved custom-command cleanup could not be persisted:', error);
        }
      }
    } else {
      configErrors = parseResult.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      );
      console.error('[Bootstrap] Config validation failed, using defaults:', configErrors);
      parsedConfig = SarahConfigSchema.parse({});
    }

    lifecycle.setCapability('storage', 'ready');
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
