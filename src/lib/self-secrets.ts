import { createVaultBoot, type AppVaultCredentials, type VaultBoot } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';

// Instrumentation and route bundles share this slot, never process.env or disk.
const SELF_SECRETS_KEY = Symbol.for('imajin.learn.selfSecrets');
interface SelfSecretsStore {
  [SELF_SECRETS_KEY]?: VaultBoot<ServerConfig>;
}

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly sessionSecret: string;
}

export class SelfSecretsUnavailableError extends Error {
  constructor() {
    super('Required app credentials unavailable: sync and set/rotate App secrets on /jin with owner countersign, then restart. No env fallback.');
    this.name = 'SelfSecretsUnavailableError';
  }
}

export function clearSelfSecrets(): void {
  delete (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY];
}

/** Check presence only: never read, copy or log a legacy env credential value. */
export function warnIgnoredSelfSecretEnv(): void {
  for (const { name } of manifest.secrets) {
    if (Object.hasOwn(process.env, name)) {
      console.warn(`${name} is ignored; it is sealed in the vault. Delete it from the env file.`);
    }
  }
}

function configure(credentials: AppVaultCredentials): ServerConfig {
  for (const { name } of manifest.secrets) {
    if (!credentials.values[name] || credentials.degraded.includes(name)) {
      throw new SelfSecretsUnavailableError();
    }
  }
  const databaseUrl = credentials.values.DATABASE_URL;
  const sessionSecret = credentials.values.SESSION_SECRET;
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || sessionSecret.length < 32) {
    throw new SelfSecretsUnavailableError();
  }
  return { databaseUrl, sessionSecret };
}

/** Called only after the SDK has authenticated/established this app's keystore. */
export async function bootstrapSelfSecrets(): Promise<void> {
  clearSelfSecrets();
  const boot = createVaultBoot<ServerConfig>({
    vault: {
      appDid: process.env.IMAJIN_APP_DID,
      kernelUrl: process.env.IMAJIN_KERNEL_URL,
      keystorePath: process.env.IMAJIN_APP_KEYSTORE,
      keys: manifest.secrets.map(({ name }) => ({ key: name, onMissing: 'fail' })),
    },
    configure,
  });
  (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY] = boot;
  try {
    await boot.start(async () => {
      // No static server/DB import above this boundary. The SDK exposes its
      // frozen config before this callback, including to separate Next bundles.
      const server = await import('../server');
      server.initializeServer();
    });
  } catch {
    clearSelfSecrets();
    // The framework reports this single sanitized error at boot. Never log the
    // provider error (or attach it as a cause), which could contain key material.
    throw new SelfSecretsUnavailableError();
  }
}

export function getServerConfig(): Readonly<ServerConfig> {
  try {
    const boot = (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY];
    if (boot) return boot.getConfig();
  } catch {
    // Normalize the SDK's pre-boot error without a provider cause or value.
  }
  throw new SelfSecretsUnavailableError();
}

export function getSessionSecret(): string {
  return getServerConfig().sessionSecret;
}
