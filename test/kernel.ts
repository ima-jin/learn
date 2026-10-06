/**
 * A fake kernel for route tests: stubs `fetch` for every kernel endpoint the
 * app calls through the published SDK (`@ima-jin/auth`, `@ima-jin/config`) or
 * directly (pay checkout), so the REAL `requireSessionOrAppToken` runs.
 *
 * Test callers authenticate with `Authorization: Bearer tok:<did>`; the fake
 * `POST /auth/api/tokens/app/verify` accepts it only for this app's own `aud`.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { resetDb } from './stubs/db';

export const APP_HOST = 'learn.test';
export const AUTH_URL = 'https://kernel.test/auth';
export const PAY_URL = 'https://kernel.test/pay';
export const REGISTRY_URL = 'https://kernel.test/registry';
export const PROFILE_URL = 'https://kernel.test/profile';

export interface KernelCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeKernel {
  calls: KernelCall[];
  /** Overrides for individual endpoints, keyed by URL path suffix. */
  respond: Map<string, () => Response>;
  profiles: Map<string, { did: string; handle: string | null; displayName: string | null; email?: string }>;
  nodeSelf: Record<string, unknown> | null;
}

function jsonRes(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function readBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

type Handler = (kernel: FakeKernel, body: Record<string, unknown> | null, headers: Headers) => Response;

/** One handler per kernel endpoint the app talks to. */
const ENDPOINTS: Record<string, Handler> = {
  [`${AUTH_URL}/api/tokens/app/verify`]: (_kernel, body) => {
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token.startsWith('tok:') || body?.aud !== APP_HOST) return jsonRes({ valid: false }, 401);
    return jsonRes({ sub: token.slice(4), aud: APP_HOST, scopes: ['learn:test'] });
  },
  // Legacy shared session cookie fallback: `imajin_session=good:<did>`.
  [`${AUTH_URL}/api/session`]: (_kernel, _body, headers) => {
    const match = /imajin_session=good:([^;]+)/.exec(headers.get('cookie') ?? '');
    return match ? jsonRes({ did: match[1] }) : jsonRes({ error: 'invalid' }, 401);
  },
  [`${REGISTRY_URL}/api/node/self`]: (kernel) =>
    kernel.nodeSelf ? jsonRes(kernel.nodeSelf) : jsonRes({ error: 'nope' }, 500),
  [`${PROFILE_URL}/api/resolve`]: (kernel, body) => {
    const dids = (body?.dids as string[]) ?? [];
    const results = dids.flatMap((did) => {
      const profile = kernel.profiles.get(did);
      return profile ? [profile] : [];
    });
    return jsonRes({ results });
  },
  [`${PAY_URL}/api/checkout`]: () => jsonRes({ id: 'cs_test', url: 'https://pay.test/checkout/cs_test' }),
  [`${AUTH_URL}/api/attestations`]: () => jsonRes({ id: 'att_test' }, 201),
};

function handle(kernel: FakeKernel, url: string, init?: RequestInit): Response {
  for (const [suffix, responder] of kernel.respond) {
    if (url.endsWith(suffix)) return responder();
  }

  const endpoint = ENDPOINTS[url];
  if (!endpoint) return jsonRes({ error: `unexpected kernel call: ${url}` }, 404);
  return endpoint(kernel, readBody(init) as Record<string, unknown> | null, new Headers(init?.headers));
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Installs the fake kernel + resets the database around every test in the calling file. */
export function installFakeKernel(): FakeKernel {
  const kernel: FakeKernel = { calls: [], respond: new Map(), profiles: new Map(), nodeSelf: null };

  beforeEach(async () => {
    await resetDb();
    kernel.calls = [];
    kernel.respond = new Map();
    kernel.profiles = new Map();
    kernel.nodeSelf = {
      did: 'did:imajin:node',
      nodeOperatorDid: 'did:imajin:operator',
      nodeFeeBps: 100,
      buyerCreditBps: 50,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        kernel.calls.push({ url, method: init?.method ?? 'GET', headers, body: readBody(init) });
        try {
          return Promise.resolve(handle(kernel, url, init));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  return kernel;
}
