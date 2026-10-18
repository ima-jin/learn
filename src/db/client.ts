import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getServerConfig } from '../lib/self-secrets';
import * as schema from './schema';

// Imported only by the delayed server module inside createVaultBoot.start().
export function createDatabase() {
  const { databaseUrl } = getServerConfig();
  return drizzle(postgres(databaseUrl, { max: 1 }), { schema });
}
