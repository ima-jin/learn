import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { readKeystoreMock, cookieMock, signMock, verifyMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(() => ({})),
  cookieMock: vi.fn(),
  signMock: vi.fn(),
  verifyMock: vi.fn(),
}));

vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  readKeystore: readKeystoreMock,
  resolveKeystorePath: () => '/unused',
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieMock }),
}));

// Exercise the real SDK handlers/cookie logic without accessing the vault or
// generating any signing material. Cryptographic correctness belongs to the SDK.
vi.mock('@/lib/self-secrets', () => ({ getSessionSecret: () => '' }));
const require = createRequire(import.meta.url);
const joseManifest = require.resolve('jose/package.json', { paths: [require.resolve('@ima-jin/auth-client')] });
const josePath = resolve(dirname(joseManifest), require(joseManifest).exports['.'].import);
vi.doMock(josePath, () => ({
  SignJWT: class {
    constructor(payload: unknown) {
      signMock.mockResolvedValue('test-session');
      verifyMock.mockResolvedValue({ payload });
    }
    setProtectedHeader() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    sign = signMock;
  },
  jwtVerify: verifyMock,
}));

const USER_DID = 'did:imajin:student';
const QUERY = `?attestation_id=att_test&user_did=${encodeURIComponent(USER_DID)}`;

function request(url: string): NextRequest {
  return new NextRequest(url, { nextConfig: { basePath: '/learn' } });
}

describe('standalone sign-in callback handoff', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://learn.test/learn');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/learn');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.test');
    readKeystoreMock.mockReturnValue({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      did: USER_DID,
      displayName: 'Student',
      handle: 'student',
    })));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reaches the existing callback, sets a session, and lands on the app home without another login redirect', async () => {
    const { middleware } = await import('../middleware');
    const { GET: callback } = await import('../app/api/auth/callback/route');
    const { GET: session } = await import('../app/api/auth/session/route');

    const forwarded = middleware(request(`https://learn.test/learn${QUERY}`));
    const callbackUrl = forwarded.headers.get('location')!;
    expect(callbackUrl).toBe(`https://learn.test/learn/api/auth/callback${QUERY}`);
    const callbackRequest = request(callbackUrl);
    expect(middleware(callbackRequest).headers.get('x-middleware-next')).toBe('1');
    const response = await callback(callbackRequest);

    expect(fetch).toHaveBeenCalledWith(
      `https://kernel.test/profile/api/profile/${encodeURIComponent(USER_DID)}`,
      { headers: { 'Content-Type': 'application/json' } },
    );
    expect(signMock).toHaveBeenCalledOnce();
    const cookie = response.cookies.get('imajin_session')!;
    expect(cookie).toMatchObject({ value: 'test-session', httpOnly: true, sameSite: 'lax', path: '/' });
    expect(response.headers.get('location')).toBe('https://learn.test/learn/');

    cookieMock.mockReturnValue({ value: cookie.value });
    expect(await (await session()).json()).toMatchObject({
      did: USER_DID,
      attestationId: 'att_test',
    });
    expect(verifyMock).toHaveBeenCalledWith(cookie.value, expect.any(Uint8Array));

    const homeRequest = request(response.headers.get('location')!);
    homeRequest.cookies.set(cookie.name, cookie.value);
    const home = middleware(homeRequest);
    expect(home.headers.get('x-middleware-next')).toBe('1');
    expect(home.headers.get('location')).toBeNull();
  });

  it('keeps missing-parameter errors inside the app basePath', async () => {
    const { GET } = await import('../app/api/auth/callback/route');
    const response = await GET(request('https://learn.test/learn/api/auth/callback'));

    expect(response.headers.get('location')).toBe('https://learn.test/learn/?auth_error=missing_params');
    expect(response.cookies.get('imajin_session')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'attestation_revoked'],
    [500, 'profile_fetch_failed'],
  ])('keeps profile error %s inside the app basePath', async (status, error) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({}, { status }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../app/api/auth/callback/route');
    const response = await GET(request(`https://learn.test/learn/api/auth/callback${QUERY}`));

    expect(response.headers.get('location')).toBe(`https://learn.test/learn/?auth_error=${error}`);
    expect(response.cookies.get('imajin_session')).toBeUndefined();
    expect(signMock).not.toHaveBeenCalled();
  });

  it('keeps network errors inside the app basePath', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Test network failure'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../app/api/auth/callback/route');
    const response = await GET(request(`https://learn.test/learn/api/auth/callback${QUERY}`));

    expect(response.headers.get('location')).toBe('https://learn.test/learn/?auth_error=network_error');
    expect(response.cookies.get('imajin_session')).toBeUndefined();
    expect(signMock).not.toHaveBeenCalled();
  });

  it('keeps logout inside the app basePath', async () => {
    const { POST } = await import('../app/api/auth/logout/route');
    const response = await POST(request('https://learn.test/learn/api/auth/logout'));

    expect(response.headers.get('location')).toBe('https://learn.test/learn/');
    expect(response.cookies.get('imajin_session')).toMatchObject({ value: '', maxAge: 0 });
  });
});
