import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'drizzle-kit';

// Generation only: deployment migrations use scripts/migrate.mjs and the vault.
// Only schema selection is needed to generate SQL; never load credentials.
const envPath = '.env.local';
const fileSchema = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf-8')).APP_DB_SCHEMA : undefined;
const appSchemaName = process.env.APP_DB_SCHEMA || fileSchema;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  schemaFilter: [appSchemaName],
});
