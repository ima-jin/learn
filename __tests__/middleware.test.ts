import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { readKeystoreMock, resolveKeystorePathMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(),
  resolveKeystorePathMock: vi.fn(() => '/tmp/keystore.json'),
}));

vi.mock('@ima-jin/auth-client', () => ({
  readKeystore: readKeystoreMock,
  resolveKeystorePath: resolveKeystorePathMock,
}));

/** Runs the middleware for `path` with the given claim state, mocking only the on-disk keystore check. */
async function middlewareFor(path: string, options: { claimed: boolean }): Promise<NextResponse> {
  readKeystoreMock.mockReturnValue(options.claimed ? {} : null);
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(new URL(path, 'http://localhost:3000')));
}

describe('middleware', () => {
  afterEach(() => {
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
    vi.unstubAllEnvs();
  });
  it.each([true, false])('forwards root callbacks before checking the keystore (claimed=%s)', async (claimed) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://learn.test/learn');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/learn');
    const query = '?attestation_id=att%2Ftest&user_did=did%3Aimajin%3Astudent&extra=a%20b';

    for (const root of ['/learn', '/learn/']) {
      const response = await middlewareFor(`${root}${query}`, { claimed });

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`https://learn.test/learn/api/auth/callback${query}`);
    }
    expect(readKeystoreMock).not.toHaveBeenCalled();
    expect(resolveKeystorePathMock).not.toHaveBeenCalled();
  });

  it('forwards a Next.js-normalized basePath root', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://learn.test/learn');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/learn');
    const { middleware } = await import('../middleware');
    const request = new NextRequest('https://learn.test/learn?attestation_id=att_test&user_did=did:imajin:student', {
      nextConfig: { basePath: '/learn' },
    });

    expect(request.nextUrl.pathname).toBe('/');
    expect(middleware(request).headers.get('location')).toBe(
      'https://learn.test/learn/api/auth/callback?attestation_id=att_test&user_did=did:imajin:student',
    );
    expect(readKeystoreMock).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '?attestation_id=att_test',
    '?user_did=did:imajin:student',
    '?attestation_id=&user_did=did:imajin:student',
    '?attestation_id=att_test&user_did=',
  ])('preserves both claim states without a complete callback: %s', async (query) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/learn');
    const unclaimed = await middlewareFor(`/${query}`, { claimed: false });
    expect(unclaimed.status).toBe(200);
    expect(await unclaimed.text()).toContain('href="/learn/claim"');
    expect(unclaimed.headers.get('location')).toBeNull();

    const claimed = await middlewareFor(`/${query}`, { claimed: true });
    expect(claimed.headers.get('x-middleware-next')).toBe('1');
    expect(claimed.headers.get('location')).toBeNull();
  });

  it('does not forward callback parameters on non-root routes', async () => {
    const query = '?attestation_id=att_test&user_did=did:imajin:student';
    expect((await middlewareFor(`/claim${query}`, { claimed: true })).status).toBe(404);
    expect((await middlewareFor(`/dashboard${query}`, { claimed: true })).headers.get('x-middleware-next')).toBe('1');
    expect(await (await middlewareFor(`/dashboard${query}`, { claimed: false })).text()).toContain('Not claimed yet');
  });

  it('serves the "not claimed yet" page for an ordinary route when unclaimed', async () => {
    const response = await middlewareFor('/', { claimed: false });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.toLowerCase()).toContain('not claimed yet');
  });

  it('passes /claim through when unclaimed', async () => {
    const response = await middlewareFor('/claim', { claimed: false });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes /api/health and /api/claim through when unclaimed', async () => {
    expect((await middlewareFor('/api/health', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
    expect((await middlewareFor('/api/claim', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
  });

  it('404s /claim once claimed', async () => {
    const response = await middlewareFor('/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('404s /api/claim once claimed', async () => {
    const response = await middlewareFor('/api/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('passes ordinary routes through once claimed', async () => {
    const response = await middlewareFor('/', { claimed: true });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
