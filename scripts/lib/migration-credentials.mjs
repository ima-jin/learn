import { createRequire } from 'node:module';

// The public SDK's CJS export supports plain Node; its ESM root imports
// extensionless next/headers, which needs Next's module resolver.
const { loadFromVault } = createRequire(import.meta.url)('@ima-jin/auth-client');

const UNAVAILABLE = 'Database credential unavailable: sync App secrets on /jin, set/rotate DATABASE_URL with owner countersign, then retry. No env fallback.';

function validateDatabaseUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error(UNAVAILABLE);
  }
  return value;
}

/**
 * Server/deploy credentials remain memory-only; the explicit CI switch is never inherited from DATABASE_URL.
 * @param {Record<string, string | undefined>} [env]
 */
export async function loadMigrationDatabaseUrl(env = process.env) {
  try {
    if (env.MIGRATIONS_TEST_DATABASE_URL !== undefined) {
      return validateDatabaseUrl(env.MIGRATIONS_TEST_DATABASE_URL);
    }
    const credentials = await loadFromVault({
      appDid: env.IMAJIN_APP_DID,
      kernelUrl: env.IMAJIN_KERNEL_URL,
      keystorePath: env.IMAJIN_APP_KEYSTORE,
      keys: [{ key: 'DATABASE_URL', onMissing: 'fail' }],
    });
    if (credentials.degraded.includes('DATABASE_URL')) throw new Error(UNAVAILABLE);
    return validateDatabaseUrl(credentials.values.DATABASE_URL);
  } catch {
    // No provider error, URL, response body or cause may escape to a CLI log.
    throw new Error(UNAVAILABLE);
  }
}
