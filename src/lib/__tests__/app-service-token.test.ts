import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAppServiceToken } from '@ima-jin/auth-client';
import { getSigningIdentity } from '@/lib/signing-identity';

vi.mock('@ima-jin/auth-client', () => ({ requestAppServiceToken: vi.fn() }));
vi.mock('@/lib/signing-identity', () => ({ getSigningIdentity: vi.fn() }));

const minted = { token: 'test-app-service-token', expiresIn: 100, scopes: [] };
// SDK is mocked; no signing key is created or read by these tests.
const identity = { appDid: 'did:imajin:app', privateKey: '', publicKey: '' };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test');
  vi.mocked(requestAppServiceToken).mockReset().mockResolvedValue(minted);
  vi.mocked(getSigningIdentity).mockReset().mockReturnValue(identity);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('getAppServiceToken', () => {
  it('uses the existing in-memory identity and caches until 80% of the TTL', async () => {
    vi.useFakeTimers();
    const { getAppServiceToken } = await import('../app-service-token');
    expect(await getAppServiceToken()).toBe(minted.token);
    expect(requestAppServiceToken).toHaveBeenCalledWith({
      kernelUrl: 'https://kernel.test',
      appDid: identity.appDid,
      privateKey: identity.privateKey,
      fetchOptions: { signal: expect.any(AbortSignal) },
    });
    await vi.advanceTimersByTimeAsync(79_999);
    expect(await getAppServiceToken()).toBe(minted.token);
    expect(requestAppServiceToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(requestAppServiceToken).mockResolvedValue({ ...minted, token: 'refreshed-test-token' });
    expect(await getAppServiceToken()).toBe('refreshed-test-token');
    expect(requestAppServiceToken).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous callers onto one mint', async () => {
    const { getAppServiceToken } = await import('../app-service-token');
    expect(await Promise.all([getAppServiceToken(), getAppServiceToken()])).toEqual([minted.token, minted.token]);
    expect(requestAppServiceToken).toHaveBeenCalledTimes(1);
  });

  it('sanitizes mint errors and permits a later retry', async () => {
    const { getAppServiceToken } = await import('../app-service-token');
    vi.mocked(requestAppServiceToken).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(getAppServiceToken()).rejects.toThrow('App-service token unavailable');
    expect(await getAppServiceToken()).toBe(minted.token);
    expect(requestAppServiceToken).toHaveBeenCalledTimes(2);
  });

  it('never returns the old token if refresh fails', async () => {
    vi.useFakeTimers();
    const { getAppServiceToken } = await import('../app-service-token');
    await getAppServiceToken();
    await vi.advanceTimersByTimeAsync(80_000);
    vi.mocked(requestAppServiceToken).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(getAppServiceToken()).rejects.toThrow('App-service token unavailable');
    expect(await getAppServiceToken()).toBe(minted.token);
    expect(requestAppServiceToken).toHaveBeenCalledTimes(3);
  });

  it('fails without a configured kernel URL rather than using another credential path', async () => {
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    const { getAppServiceToken } = await import('../app-service-token');
    await expect(getAppServiceToken()).rejects.toThrow('App-service token unavailable');
    expect(requestAppServiceToken).not.toHaveBeenCalled();
  });

  it('fails closed if signing identity is not bootstrapped', async () => {
    vi.mocked(getSigningIdentity).mockImplementationOnce(() => { throw new Error('unclaimed'); });
    const { getAppServiceToken } = await import('../app-service-token');
    await expect(getAppServiceToken()).rejects.toThrow('App-service token unavailable');
    expect(requestAppServiceToken).not.toHaveBeenCalled();
  });

  it.each([
    { token: '', expiresIn: 100 },
    { token: 'test-token', expiresIn: 0 },
    { token: 'test-token', expiresIn: -1 },
    { token: 'test-token', expiresIn: Number.NaN },
  ])('rejects an unusable mint response (%j) without caching it', async (response) => {
    vi.mocked(requestAppServiceToken).mockResolvedValueOnce({ ...response, scopes: [] });
    const { getAppServiceToken } = await import('../app-service-token');
    await expect(getAppServiceToken()).rejects.toThrow('App-service token unavailable');
    expect(await getAppServiceToken()).toBe(minted.token);
  });
});
