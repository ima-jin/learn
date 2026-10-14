import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken, verifySessionToken } from '@ima-jin/auth-client';
import type { AppVaultCredentials } from '@ima-jin/auth-client';
import { NextRequest } from 'next/server';
import { authConfig } from '../auth-config';
import { bootstrapSelfSecrets, clearSelfSecrets, getSessionSecret, SelfSecretsUnavailableError } from '../self-secrets';
import { bootstrapSigningIdentity, claimWithCode, isAppClaimed, resetSigningIdentityForTests } from '../signing-identity';
import { register } from '../../../instrumentation';
import manifest from '../../../imajin.app.json';

const mocks = vi.hoisted(() => ({
  loadFromVault: vi.fn(),
  loadAppSigningKey: vi.fn(),
  readKeystore: vi.fn(),
}));
vi.mock('@ima-jin/auth-client', async (original) => ({
  ...await original<typeof import('@ima-jin/auth-client')>(),
  ...mocks,
}));

const FAKE_FIRST = 'OBVIOUSLY_FAKE_SESSION_PLACEHOLDER_FIRST';
const FAKE_ROTATED = 'OBVIOUSLY_FAKE_SESSION_PLACEHOLDER_ROTATED';
const FAKE_ENV = 'OBVIOUSLY_FAKE_ENV_PLACEHOLDER_IGNORED';
const user = { did: 'did:imajin:test-user', handle: 'test-user', displayName: 'Test User', attestationId: 'test-attestation' };
const credentials = (value = FAKE_FIRST): AppVaultCredentials => ({
  values: { SESSION_SECRET: value }, degraded: [],
});

beforeEach(() => {
  resetSigningIdentityForTests();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:learn-test');
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test');
  vi.stubEnv('IMAJIN_APP_KEYSTORE', '/test-only/learn.keystore.json');
  vi.stubEnv('SESSION_SECRET', '');
  mocks.readKeystore.mockReturnValue({ publicKey: 'FAKE_BOOTSTRAP_PUBLIC', privateKey: 'FAKE_BOOTSTRAP_PRIVATE' });
  mocks.loadAppSigningKey.mockResolvedValue({
    appDid: 'did:imajin:learn-test', privateKey: 'FAKE_SIGNING_PRIVATE', publicKey: 'FAKE_SIGNING_PUBLIC',
  });
  mocks.loadFromVault.mockResolvedValue(credentials());
});
afterEach(() => {
  resetSigningIdentityForTests();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('vault-only startup', () => {
  it('boots and serves a signed-in session with no session key in env', async () => {
    await register();
    expect(isAppClaimed()).toBe(true);
    expect(mocks.loadFromVault).toHaveBeenCalledOnce();
    expect(mocks.loadFromVault).toHaveBeenCalledWith({
      appDid: 'did:imajin:learn-test',
      kernelUrl: 'https://kernel.test',
      keystorePath: '/test-only/learn.keystore.json',
      keys: manifest.secrets.map(({ name }) => ({ key: name, onMissing: 'fail' })),
    });
    const token = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(token, authConfig)).toEqual(user);
    expect(process.env.SESSION_SECRET).toBe('');
  });

  it('never uses an env fallback, including before or during boot', async () => {
    vi.stubEnv('SESSION_SECRET', FAKE_ENV);
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
    await register();
    expect(authConfig.secret).toBe(FAKE_FIRST);
    expect(process.env.SESSION_SECRET).toBe(FAKE_ENV);
  });

  it('does not finish boot or publish a signing identity while vault loading is pending', async () => {
    let resolve!: (value: AppVaultCredentials) => void;
    mocks.loadFromVault.mockImplementation(() => new Promise<AppVaultCredentials>((done) => { resolve = done; }));
    let completed = false;
    const boot = register().then(() => { completed = true; });
    await vi.waitFor(() => expect(mocks.loadFromVault).toHaveBeenCalledOnce());
    expect(mocks.loadAppSigningKey.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadFromVault.mock.invocationCallOrder[0]);
    expect(completed).toBe(false);
    expect(isAppClaimed()).toBe(false);
    await expect(createSessionToken(user, authConfig)).rejects.toThrow(SelfSecretsUnavailableError);
    resolve(credentials());
    await boot;
    expect(completed).toBe(true);
    expect(isAppClaimed()).toBe(true);
  });

  it.each([
    ['unreachable', () => mocks.loadFromVault.mockRejectedValue(new Error(FAKE_ENV))],
    ['missing', () => mocks.loadFromVault.mockResolvedValue({ values: {}, degraded: [] })],
    ['empty', () => mocks.loadFromVault.mockResolvedValue(credentials(''))],
    ['too short', () => mocks.loadFromVault.mockResolvedValue(credentials('FAKE_SHORT'))],
    ['degraded', () => mocks.loadFromVault.mockResolvedValue({ ...credentials(), degraded: ['SESSION_SECRET'] })],
  ])('fails closed when the vault is %s with a single sanitized recovery message', async (_reason, arrange) => {
    vi.stubEnv('SESSION_SECRET', FAKE_ENV);
    arrange();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = await register().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SelfSecretsUnavailableError);
    expect((error as Error).message).toBe('SESSION_SECRET unavailable: re-sync this app on /jin, then restart. No env fallback.');
    expect((error as Error).message).not.toMatch(/[\r\n]/);
    expect((error as Error).cause).toBeUndefined();
    // One framework error, not a second app log or a provider error with values.
    expect(log).not.toHaveBeenCalled();
    expect(isAppClaimed()).toBe(false);
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
  });

  it('picks up a rotated vault value on restart with no file or env change', async () => {
    await register();
    const oldToken = await createSessionToken(user, authConfig);
    mocks.loadFromVault.mockResolvedValue(credentials(FAKE_ROTATED));
    resetSigningIdentityForTests();
    await register();
    expect(authConfig.secret).toBe(FAKE_ROTATED);
    expect(await verifySessionToken(oldToken, authConfig)).toBeNull();
    const newToken = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(newToken, authConfig)).toEqual(user);
    expect(mocks.loadFromVault).toHaveBeenCalledTimes(2);
    expect(process.env.SESSION_SECRET).toBe('');
  });

  it('drops previously loaded credentials when a subsequent boot fails', async () => {
    await bootstrapSigningIdentity();
    mocks.loadFromVault.mockRejectedValue(new Error(FAKE_ENV));
    await expect(bootstrapSigningIdentity()).rejects.toThrow(SelfSecretsUnavailableError);
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
    expect(isAppClaimed()).toBe(false);
  });

  it('remains unclaimed without a keystore and cannot sign sessions', async () => {
    mocks.readKeystore.mockReturnValue(null);
    await register();
    expect(mocks.loadFromVault).not.toHaveBeenCalled();
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
  });

  it('shares memory-only credentials across Next server bundle copies', async () => {
    await bootstrapSelfSecrets();
    vi.resetModules();
    const copy = await import('../self-secrets');
    expect(copy.getSessionSecret()).toBe(FAKE_FIRST);
    expect(Object.keys(globalThis)).not.toContain('imajin.learn.selfSecrets');
    copy.clearSelfSecrets();
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
    clearSelfSecrets();
  });
});

describe('browser claim vault ordering', () => {
  it('awaits self-secrets before completing the claim', async () => {
    let resolve!: (value: AppVaultCredentials) => void;
    mocks.loadFromVault.mockImplementation(() => new Promise<AppVaultCredentials>((done) => { resolve = done; }));
    const claim = claimWithCode({ claimCode: 'FAKE_BROWSER_CLAIM_CODE' });
    await vi.waitFor(() => expect(mocks.loadFromVault).toHaveBeenCalledOnce());
    expect(isAppClaimed()).toBe(false);
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
    resolve(credentials());
    await claim;
    expect(isAppClaimed()).toBe(true);
  });

  it('returns 503 and logs one value-free /jin recovery line on a failed claim', async () => {
    mocks.loadFromVault.mockRejectedValue(new Error(FAKE_ENV));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('../../../app/api/claim/route');
    const response = await POST(new NextRequest('https://learn.test/api/claim', {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.10' },
      body: JSON.stringify({ claimCode: 'FAKE_BROWSER_CLAIM_CODE' }),
    }));
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(new SelfSecretsUnavailableError().message);
    expect(await response.json()).toEqual({ error: new SelfSecretsUnavailableError().message });
    expect(isAppClaimed()).toBe(false);
  });
});
