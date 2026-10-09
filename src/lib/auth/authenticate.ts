import { requireSessionOrAppToken } from '@ima-jin/auth';
import { APP_SLUG } from '@/lib/env';

/**
 * This app's entire inbound-auth surface, deliberately funneled through two
 * functions. Every route calls `authenticate()` / `authenticateOptional()`
 * and nothing else — no route imports `@ima-jin/auth`'s auth primitives
 * directly. Mirrors `ima-jin/links` and `ima-jin/dykil`
 * (`src/lib/auth/authenticate.ts`, the #1974 reference adoption of the
 * #1069 scoped app-token) so a future change to the underlying mechanism is
 * a one-file change, not a route-by-route migration.
 *
 * `requireSessionOrAppToken` accepts EITHER a scoped
 * `Authorization: Bearer <app-token>` (verified against this app's registry
 * slug as `aud`, imajin-ai#2706) OR the kernel session cookie as a migration fallback.
 *
 * The caller is identified by a single DID. The in-monorepo version also
 * resolved `X-Acting-As` group impersonation and the soft-DID/hard-DID tier
 * from the kernel's `Identity`; neither is part of the app-token contract,
 * so a caller always acts as themselves here (see docs/ARCHITECTURE.md).
 */
export interface AuthenticatedCaller {
  /** DID of the authenticated caller. */
  did: string;
  /** Capability scopes granted to this call (empty on the cookie fallback path). */
  scopes: string[];
  /** Which path authenticated this request. */
  via: 'token' | 'cookie';
  /** The raw app token, present only when `via === 'token'`. Used to act for the caller against the kernel. */
  appToken: string | null;
  /**
   * Owner DID when the caller is a registered agent acting under `X-Acting-For`
   * (agent delegation, ima-jin/imajin-ai#2360). Always undefined today: the
   * published `requireSessionOrAppToken` result does not surface it (see
   * docs/ARCHITECTURE.md). The delegation policy reads it as soon as it does.
   */
  actingFor?: string | null;
}

export type AuthenticateResult = { auth: AuthenticatedCaller } | { error: string; status: number };

export interface AuthenticateOptions {
  requireScopes?: string[];
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export async function authenticate(request: Request, options?: AuthenticateOptions): Promise<AuthenticateResult> {
  const result = await requireSessionOrAppToken(request, {
    slug: APP_SLUG,
    requireScopes: options?.requireScopes,
  });
  if ('error' in result) {
    return { error: result.error, status: result.status };
  }
  const { did, scopes, via } = result.auth;
  return { auth: { did, scopes, via, appToken: via === 'token' ? bearerToken(request) : null } };
}

/** Like `authenticate`, but anonymous callers (or invalid credentials) yield `null` instead of an error. */
export async function authenticateOptional(request: Request): Promise<AuthenticatedCaller | null> {
  const result = await authenticate(request);
  if ('error' in result) return null;
  return result.auth;
}
