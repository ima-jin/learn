/**
 * Test stand-in for `src/db/index.ts` (aliased in vitest.config.ts): the same
 * drizzle `db` + schema exports, but backed by an in-process Postgres
 * (PGlite) that has this repo's REAL migrations applied — so route tests run
 * real SQL against the real `learn` schema instead of mocking query builders.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';

export * from '../../src/db/schema';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const client = new PGlite();

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));
for (const file of migrationFiles) {
  const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8').split(STATEMENT_BREAKPOINT);
  for (const statement of statements) {
    if (statement.trim()) await client.exec(statement);
  }
}

export const db = drizzle(client, { schema });

/** Empties every learn table between tests. */
export async function resetDb(): Promise<void> {
  await client.exec(
    'TRUNCATE learn.lesson_progress, learn.enrollments, learn.lessons, learn.modules, learn.courses CASCADE',
  );
}
