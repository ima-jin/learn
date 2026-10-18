#!/usr/bin/env node
/**
 * Idempotent migration baseline for an EXISTING `learn` schema
 * (refs ima-jin/imajin-ai#2504). Run it once per database before the first
 * `pnpm db:migrate`; it is safe to re-run on every deploy.
 *
 *   node --env-file=.env.local scripts/migrate-baseline.mjs [--dry-run]
 *
 * Fetches DATABASE_URL from the vault using this app's bootstrap keystore.
 * Only MIGRATIONS_TEST_DATABASE_URL opts into a disposable CI/test database.
 * Reads non-secret APP_DB_SCHEMA (default `learn`) from env. See docs/DEPLOY.md and
 * scripts/lib/migrate-baseline-core.mjs for the full safety contract.
 *
 * Exit codes:
 *   0  baselined, already baselined, or fresh database (nothing to baseline)
 *   1  REFUSED: live schema (or migration history) does not match what this
 *      app expects — nothing was changed; fix by hand, do not force
 *   2  usage / configuration / connection error
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { assertIdentifier, BaselineMismatchError, runBaseline } from './lib/migrate-baseline-core.mjs';
import { loadMigrationDatabaseUrl } from './lib/migration-credentials.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

const MESSAGES = {
  baselined: (tag) => `Baselined: recorded ${tag} as applied. Next: pnpm db:migrate`,
  'already-baselined': (tag) => `Already baselined (${tag} is recorded) — nothing to do.`,
  'fresh-database': () => 'Fresh database: the app schema does not exist yet — nothing to baseline. Next: pnpm db:migrate',
  'would-baseline': (tag) => `Dry run: live schema matches; would record ${tag} as applied. Nothing was written.`,
};

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export async function main(argv, env = process.env) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error('Unknown argument. Usage: migrate-baseline.mjs [--dry-run]');
    return 2;
  }

  try {
    const schema = assertIdentifier(env.APP_DB_SCHEMA || 'learn', 'APP_DB_SCHEMA');
    const databaseUrl = await loadMigrationDatabaseUrl(env);
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let result;
    try {
      result = await runBaseline(sql, {
        schema,
        migrationsFolder: MIGRATIONS_FOLDER,
        dryRun: argv.includes('--dry-run'),
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
    console.log(MESSAGES[result.status](result.tag));
    return 0;
  } catch (error) {
    if (error instanceof BaselineMismatchError) {
      console.error(error.message);
      console.error('\nNothing was changed. Do NOT force this: reconcile the schema by hand, then re-run.');
      return 1;
    }
    console.error('Baseline failed: verify APP_DB_SCHEMA and the app keystore; sync/set/rotate DATABASE_URL in App secrets on /jin with owner countersign, then retry. No env fallback.');
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
