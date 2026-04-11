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

export interface AppContext {
  bus: MessageBus;
  registry: ServiceRegistry;
  config: StorageProvider;
  db: StorageProvider;
  /** Validated and defaulted config snapshot. Re-read after save-config. */
  parsedConfig: SarahConfig;
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
  const keyManager = new KeyManager(userDataPath);
  const encryptionKey = keyManager.getOrCreateKey();

  const bus = new MessageBus();
  const registry = new ServiceRegistry(bus);

  const rawConfig = new JsonStorage(path.join(userDataPath, 'config.json'));
  const rawDb = new SqliteStorage(path.join(userDataPath, 'sarah.db'));
  const config = new EncryptedStorage(rawConfig, encryptionKey);
  const db = new EncryptedStorage(rawDb, encryptionKey);

  // Validate config — safeParse so caller can handle errors gracefully
  const raw = (await config.get<Record<string, unknown>>('root')) ?? {};
  const parseResult = SarahConfigSchema.safeParse(raw);

  let parsedConfig: SarahConfig;
  let configErrors: string[] | null = null;
  if (parseResult.success) {
    parsedConfig = parseResult.data;
  } else {
    configErrors = parseResult.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    console.error('[Bootstrap] Config validation failed, using defaults:', configErrors);
    parsedConfig = SarahConfigSchema.parse({});
  }

  return {
    bus,
    registry,
    config,
    db,
    parsedConfig,
    configErrors,
    shutdown: async () => {
      await registry.destroyAll();
      await config.close();
      await db.close();
    },
  };
}
