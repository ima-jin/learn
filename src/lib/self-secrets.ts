import { loadFromVault } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';

// Instrumentation and route bundles share this slot, never process.env or disk.
const SELF_SECRETS_KEY = Symbol.for('imajin.learn.selfSecrets');
interface SelfSecretsStore {
  [SELF_SECRETS_KEY]?: Readonly<Record<string, string>>;
}

export class SelfSecretsUnavailableError extends Error {
  constructor() {
    super('SESSION_SECRET unavailable: re-sync this app on /jin, then restart. No env fallback.');
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
      console.warn(`${name} is ignored; it is issued by the kernel vault. Delete it from the env file.`);
    }
  }
}

/** Called only after the SDK has authenticated/established this app's keystore. */
export async function bootstrapSelfSecrets(): Promise<void> {
  clearSelfSecrets();
  try {
    const credentials = await loadFromVault({
      appDid: process.env.IMAJIN_APP_DID,
      kernelUrl: process.env.IMAJIN_KERNEL_URL,
      keystorePath: process.env.IMAJIN_APP_KEYSTORE,
      keys: manifest.secrets.map(({ name }) => ({ key: name, onMissing: 'fail' })),
    });
    const values: Record<string, string> = Object.create(null);
    for (const { name } of manifest.secrets) {
      const value = credentials.values[name];
      if (typeof value !== 'string' || value.length < 32 || credentials.degraded.includes(name)) {
        throw new SelfSecretsUnavailableError();
      }
      values[name] = value;
    }
    (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY] = Object.freeze(values);
  } catch {
    // The framework reports this single sanitized error at boot. Never log the
    // provider error (or attach it as a cause), which could contain key material.
    throw new SelfSecretsUnavailableError();
  }
}

export function getSessionSecret(): string {
  const value = (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY]?.SESSION_SECRET;
  if (!value) throw new SelfSecretsUnavailableError();
  return value;
}
