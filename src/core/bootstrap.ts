import * as path from 'path';
import { MessageBus } from './message-bus.js';
import { ServiceRegistry } from './service-registry.js';
import { JsonStorage } from './storage/json-storage.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { EncryptedStorage } from './storage/encrypted-storage.js';
import { KeyManager } from './crypto/key-manager.js';
import type { StorageProvider } from './storage/storage.interface.js';

export interface AppContext {
  bus: MessageBus;
  registry: ServiceRegistry;
  config: StorageProvider;
  db: StorageProvider;
  shutdown: () => Promise<void>;
}

/**
 * Bootstrap the S.A.R.A.H. application.
 * Creates and wires up all core infrastructure.
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

  await registry.initAll();

  return {
    bus,
    registry,
    config,
    db,
    shutdown: async () => {
      await registry.destroyAll();
      await config.close();
      await db.close();
    },
  };
}
