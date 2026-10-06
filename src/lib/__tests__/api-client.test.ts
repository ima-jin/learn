import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnFetch, resetAppTokenCache } from '../api-client';

const AUTH = 'https://kernel.test';

interface Call {
  url: string;
  init?: RequestInit;
}

let calls: Call[];
let mint: () => Response;

beforeEach(() => {
  calls = [];
  resetAppTokenCache();
  mint = () => Response.json({ token: 'tok-1', expiresIn: 600, scopes: [] });
  vi.stubEnv('NEXT_PUBLIC_IMAJIN_AUTH_URL', AUTH);
  vi.stubGlobal('location', { host: 'learn.test' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      return url === `${AUTH}/auth/api/tokens/app` ? mint() : Response.json({ ok: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const apiCalls = () => calls.filter((c) => !c.url.includes('/auth/api/tokens/app'));
const authHeader = (call: Call) => new Headers(call.init?.headers).get('authorization');

describe('learnFetch', () => {
  it("mints an app token scoped to this app's host from the kernel session, and sends it as a bearer", async () => {
    await learnFetch('/api/my/courses');

    const minted = calls[0];
    expect(minted.url).toBe(`${AUTH}/auth/api/tokens/app`);
    expect(minted.init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(minted.init?.body as string)).toEqual({ aud: 'learn.test', scopes: [] });

    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0].url).toBe('/api/my/courses');
    expect(authHeader(apiCalls()[0])).toBe('Bearer tok-1');
  });

  it('keeps the caller\'s own init and headers', async () => {
    await learnFetch('/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const call = apiCalls()[0];
    expect(call.init?.method).toBe('POST');
    expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    expect(authHeader(call)).toBe('Bearer tok-1');
  });

  it('reuses a still-fresh token instead of minting per request', async () => {
    await learnFetch('/api/a');
    await learnFetch('/api/b');
    expect(calls.filter((c) => c.url.includes('/auth/api/tokens/app'))).toHaveLength(1);
    expect(apiCalls()).toHaveLength(2);
  });

  it('mints a fresh token once the cached one is about to expire', async () => {
    mint = () => Response.json({ token: 'short', expiresIn: 10 }); // inside the refresh margin
    await learnFetch('/api/a');
    mint = () => Response.json({ token: 'fresh', expiresIn: 600 });
    await learnFetch('/api/b');
    expect(authHeader(apiCalls()[1])).toBe('Bearer fresh');
  });

  it.each([
    ['the kernel refuses (signed out / app not registered)', () => new Response('no', { status: 401 })],
    ['the kernel returns no token', () => Response.json({})],
    ['the kernel is unreachable', () => { throw new Error('offline'); }],
  ])('goes out anonymous, never failing the request, when %s', async (_name, response) => {
    mint = response;
    const res = await learnFetch('/api/courses');
    expect(res.ok).toBe(true);
    expect(authHeader(apiCalls()[0])).toBeNull();
  });

  it('skips minting entirely when no kernel URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_AUTH_URL', '');
    await learnFetch('/api/courses');
    expect(calls).toHaveLength(1);
    expect(authHeader(calls[0])).toBeNull();
  });

  it('passes absolute URLs through untouched', async () => {
    await learnFetch('https://elsewhere.test/x');
    expect(apiCalls()[0].url).toBe('https://elsewhere.test/x');
  });
});
