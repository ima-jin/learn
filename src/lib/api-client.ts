import { apiFetch } from '@ima-jin/config';

/**
 * Browser-side client for this app's own `/api/*` routes, speaking the
 * app-token contract end to end (#1974 / #1069): it mints a short-lived
 * app token — scoped to THIS app's host as `aud` — from the visitor's kernel
 * session via `POST {kernel}/auth/api/tokens/app`, and sends it as
 * `Authorization: Bearer`. The routes verify it with
 * `requireSessionOrAppToken`. No token (signed out, kernel unreachable, app
 * not registered yet) simply means the request goes out anonymous.
 *
 * The mint call is the same one `@ima-jin/auth-client`'s `requestAppToken`
 * makes. It is re-implemented here (ten lines) because that package's root
 * entry also imports `next/headers`, `fs` and `path`, which cannot be bundled
 * for the browser — see ima-jin/imajin-ai#2647.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 30_000;

let cached: CachedToken | null = null;

/** Test-only: forget the cached token. */
export function resetAppTokenCache(): void {
  cached = null;
}

async function mintAppToken(): Promise<string | null> {
  const authUrl = process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL;
  if (!authUrl) return null;

  try {
    const response = await fetch(`${authUrl}/auth/api/tokens/app`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aud: globalThis.location.host, scopes: [] }),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { token?: string; expiresIn?: number };
    if (!data.token) return null;

    cached = { token: data.token, expiresAt: Date.now() + (data.expiresIn ?? 0) * 1000 };
    return data.token;
  } catch {
    return null;
  }
}

async function getAppToken(): Promise<string | null> {
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
  return mintAppToken();
}

/** `fetch` for this app's own API: same-origin, base-path aware, app-token authenticated when possible. */
export async function learnFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAppToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return apiFetch(path, { ...init, headers });
}
