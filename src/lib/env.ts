/**
 * Central env-var accessors. `.env.example` is the contract (AGENTS.md §5) —
 * no hard-coded kernel URLs anywhere else in this app.
 */

/** This app's own host, used as the `aud` for scoped app-token verification. */
export function thisAppHost(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const fallback = 'learn.imajin.ai';
  if (!base) return fallback;
  try {
    return new URL(base).host;
  } catch {
    return fallback;
  }
}

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

/**
 * Bearer secret the kernel presents to `POST /api/webhook` when a paid checkout completes (the kernel's
 * `LEARN_WEBHOOK_SECRET`), or null when unset. Callers must fail closed on null.
 */
export function webhookSecret(): string | null {
  return process.env.WEBHOOK_SECRET || null;
}

/**
 * This app's public base URL including its mount path — what a checkout redirect must point at.
 * `NEXT_PUBLIC_APP_URL` already carries the base path (`https://jin.imajin.ai/learn`); without it,
 * fall back to the request origin plus `NEXT_PUBLIC_BASE_PATH`.
 */
export function appBaseUrl(requestOrigin: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.endsWith('/') ? configured.slice(0, -1) : configured;
  return `${requestOrigin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}`;
}
