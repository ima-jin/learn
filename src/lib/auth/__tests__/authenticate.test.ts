import { describe, expect, it } from 'vitest';
import { authenticate, authenticateOptional } from '../authenticate';
import { makeRequest } from '@test/helpers';
import { AUTH_URL, installFakeKernel } from '@test/kernel';

const kernel = installFakeKernel();

describe('authenticate', () => {
  it("accepts a scoped app token verified for THIS app's host, exposing did, scopes and the raw token", async () => {
    const result = await authenticate(makeRequest('GET', '/x', { did: 'did:imajin:a' }));
    expect(result).toEqual({
      auth: { did: 'did:imajin:a', scopes: ['learn:test'], via: 'token', appToken: 'tok:did:imajin:a' },
    });
    const verify = kernel.calls.find((c) => c.url === `${AUTH_URL}/api/tokens/app/verify`);
    expect(verify?.body).toEqual({ token: 'tok:did:imajin:a', aud: 'learn.test' });
  });

  it('rejects a token the kernel does not verify for this audience', async () => {
    const result = await authenticate(makeRequest('GET', '/x', { headers: { authorization: 'Bearer minted-for-another-app' } }));
    expect(result).toMatchObject({ status: 401 });
  });

  it('falls back to the kernel session cookie, with no scopes and no app token', async () => {
    const result = await authenticate(makeRequest('GET', '/x', { cookieDid: 'did:imajin:c' }));
    expect(result).toEqual({ auth: { did: 'did:imajin:c', scopes: [], via: 'cookie', appToken: null } });
  });

  it('rejects an invalid cookie and an anonymous request with 401', async () => {
    const bad = await authenticate(makeRequest('GET', '/x', { headers: { cookie: 'imajin_session=forged' } }));
    expect(bad).toMatchObject({ status: 401, error: 'Invalid or expired session' });
    const anon = await authenticate(makeRequest('GET', '/x'));
    expect(anon).toMatchObject({ status: 401 });
  });

  it('enforces requireScopes on the token path (403) and passes when granted', async () => {
    const denied = await authenticate(makeRequest('GET', '/x', { did: 'did:imajin:a' }), { requireScopes: ['learn:write'] });
    expect(denied).toMatchObject({ status: 403 });
    const ok = await authenticate(makeRequest('GET', '/x', { did: 'did:imajin:a' }), { requireScopes: ['learn:test'] });
    expect('auth' in ok).toBe(true);
  });
});

describe('authenticateOptional', () => {
  it('returns the caller when authenticated and null otherwise', async () => {
    expect(await authenticateOptional(makeRequest('GET', '/x', { did: 'did:imajin:a' }))).toMatchObject({ did: 'did:imajin:a' });
    expect(await authenticateOptional(makeRequest('GET', '/x'))).toBeNull();
    expect(await authenticateOptional(makeRequest('GET', '/x', { headers: { authorization: 'Bearer bogus' } }))).toBeNull();
  });
});
