/**
 * Central env-var accessors. `.env.example` is the contract (AGENTS.md §5) —
 * no hard-coded kernel URLs anywhere else in this app.
 */

/**
 * This app's registry slug — the `aud` scoped app tokens are minted and verified
 * against. Never a host: path-routed apps share one (imajin-ai#2706);
 * `@ima-jin/auth` also honours an `IMAJIN_APP_AUD` override.
 */
export const APP_SLUG = 'learn';

/** Base URL of the kernel's auth service (includes the `/auth` prefix), or null when unset. */
export function authServiceUrl(): string | null {
  return process.env.AUTH_SERVICE_URL || null;
}

/** Base URL of the kernel's pay service (includes the `/pay` prefix), or null when unset. */
export function payServiceUrl(): string | null {
  const explicit = process.env.PAY_SERVICE_URL;
  if (explicit) return explicit;
  const kernel = process.env.IMAJIN_KERNEL_URL;
  return kernel ? `${kernel}/pay` : null;
}
