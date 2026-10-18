#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { assertIdentifier } from './lib/migrate-baseline-core.mjs';
import { loadMigrationDatabaseUrl } from './lib/migration-credentials.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Same vault credential and schema-local journal as the baseline, never a server env credential.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export async function main(argv, env = process.env) {
  if (argv.length > 0) {
    console.error('Usage: migrate.mjs');
    return 2;
  }
  try {
    const schema = assertIdentifier(env.APP_DB_SCHEMA || 'learn', 'APP_DB_SCHEMA');
    const databaseUrl = await loadMigrationDatabaseUrl(env);
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(sql), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: schema,
        migrationsTable: '__drizzle_migrations',
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
    console.log('App migrations complete.');
    return 0;
  } catch {
    console.error('Migration failed: verify APP_DB_SCHEMA and the app keystore; sync/set/rotate DATABASE_URL in App secrets on /jin with owner countersign, then retry. No env fallback.');
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
