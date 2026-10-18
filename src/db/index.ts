import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from './schema';
import { getServerConfig, type ServerConfig, SelfSecretsUnavailableError } from '../lib/self-secrets';

export type Database = PostgresJsDatabase<typeof schema>;
const DATABASE_KEY = Symbol.for('imajin.learn.database');
interface DatabaseStore {
  [DATABASE_KEY]?: { config: Readonly<ServerConfig>; database: Database };
}

export function installDatabase(database: Database): void {
  (globalThis as DatabaseStore)[DATABASE_KEY] = { config: getServerConfig(), database };
}

function initializedDatabase(): Database {
  const config = getServerConfig();
  const entry = (globalThis as DatabaseStore)[DATABASE_KEY];
  if (entry?.config !== config) throw new SelfSecretsUnavailableError();
  return entry.database;
}

// Next imports routes during builds and in the unclaimed shell. Neither may
// construct a client. A stale database from a failed boot is also inaccessible.
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const database = initializedDatabase();
    const value = Reflect.get(database, property);
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
export * from './schema';
