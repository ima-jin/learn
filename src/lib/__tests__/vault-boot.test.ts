import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeAppSecretFetchPayload, generateBootstrapKeypair, signBootstrapPayload, writeKeystore,
  type AppSecretEnvelope, type AppSecretFetchPayload,
} from '@ima-jin/auth-client';
import { deriveXKeypairFromEd25519, sealSecret, wrapFieldKey } from '@ima-jin/vault-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  postgres: vi.fn(),
  drizzle: vi.fn(),
  select: vi.fn(),
}));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }));

// Shape-only, password-free fixtures. No real database is contacted.
const FAKE_DATABASE = 'postgres://database.invalid/TEST_ONLY_NOT_A_DATABASE';
const FAKE_SESSION = 'OBVIOUSLY_FAKE_SESSION_PLACEHOLDER_FOR_TESTS';
const FAKE_PROVIDER_ERROR = 'OBVIOUSLY_FAKE_PROVIDER_VALUE_MUST_NOT_ESCAPE';
const APP_DID = 'did:imajin:learn-test';
const bootstrap = generateBootstrapKeypair();
const sender = deriveXKeypairFromEd25519(generateBootstrapKeypair().privateKey, 'TEST_ONLY_SENDER');

function envelope(request: AppSecretFetchPayload, values: Record<string, string>): AppSecretEnvelope {
  const key = randomBytes(32);
  try {
    const selected = Object.fromEntries(request.keys.filter((name) => name in values).map((name) => [name, values[name]]));
    const sealed = sealSecret(JSON.stringify({
      domain: request.domain, appDid: request.appDid, nonce: request.nonce, keys: request.keys,
      values: selected, missing: request.keys.filter((name) => !(name in values)),
    }), key);
    return {
      version: 1, senderXPub: sender.publicKey, sealed,
      wrappedKey: wrapFieldKey(key, request.recipientXPub, sender.privateKey),
    };
  } finally {
    key.fill(0);
  }
}

let dir: string;
let values: Record<string, string>;
let waitForSession: Promise<void>;
let transform: (sealed: AppSecretEnvelope) => AppSecretEnvelope;
let refuse = false;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.events.length = 0;
  values = { DATABASE_URL: FAKE_DATABASE, SESSION_SECRET: FAKE_SESSION };
  waitForSession = Promise.resolve();
  transform = (sealed) => sealed;
  refuse = false;
  dir = await mkdtemp(join(tmpdir(), 'learn-vault-test-'));
  writeKeystore(join(dir, 'bootstrap.json'), bootstrap);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('IMAJIN_APP_DID', APP_DID);
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test');
  vi.stubEnv('IMAJIN_APP_KEYSTORE', join(dir, 'bootstrap.json'));
  vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('SESSION_SECRET', undefined);
  for (const method of ['warn', 'error', 'info', 'log', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
  const secrets = await import('../self-secrets');
  secrets.clearSelfSecrets();
  mocks.postgres.mockImplementation((url: string) => {
    mocks.events.push('initialize:postgres');
    expect(secrets.getServerConfig().databaseUrl).toBe(url);
    return { TEST_ONLY_CLIENT: true };
  });
  mocks.drizzle.mockImplementation(() => {
    mocks.events.push('initialize:drizzle');
    return { select: mocks.select, query: { TEST_ONLY_QUERY: true } };
  });
  vi.doMock('../../server', async (original) => {
    mocks.events.push('import:server');
    return original();
  });
  vi.doMock('../../db/client', async (original) => {
    mocks.events.push('import:db-client');
    return original();
  });
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    if (String(url).endsWith('/api/apps/signing-key/fetch')) {
      mocks.events.push('fetch:identity');
      return Response.json({ appDid: APP_DID, privateKey: 'TEST_ONLY_SIGNING_PRIVATE', publicKey: 'TEST_ONLY_SIGNING_PUBLIC' });
    }
    expect(String(url)).toBe('https://kernel.test/api/apps/secrets/fetch');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    const request = JSON.parse(String(init.body)) as AppSecretFetchPayload & { signature: string };
    expect(request.signature).toBe(signBootstrapPayload(canonicalizeAppSecretFetchPayload(request), bootstrap.privateKey));
    expect(request.appDid).toBe(APP_DID);
    const name = request.keys[0];
    mocks.events.push(`fetch:${name}`);
    if (refuse) throw new Error(FAKE_PROVIDER_ERROR);
    if (name === 'SESSION_SECRET') await waitForSession;
    return Response.json(transform(envelope(request, values)));
  }));
});

afterEach(async () => {
  const { resetSigningIdentityForTests } = await import('../signing-identity');
  resetSigningIdentityForTests();
  vi.doUnmock('../../server');
  vi.doUnmock('../../db/client');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('real createVaultBoot application boundary', () => {
  it('imports and initializes the database only after all encrypted credentials load', async () => {
    let release!: () => void;
    waitForSession = new Promise<void>((resolve) => { release = resolve; });
    // Build/route discovery may import this facade but cannot construct a client.
    const { db } = await import('../../db');
    const { getServerConfig } = await import('../self-secrets');
    expect(() => db.select).toThrow(/Required app credentials unavailable/);
    expect(mocks.postgres).not.toHaveBeenCalled();
    const { register } = await import('../../../instrumentation');
    const boot = register();
    await vi.waitFor(() => expect(mocks.events).toContain('fetch:SESSION_SECRET'));
    expect(mocks.events).toEqual(['fetch:identity', 'fetch:DATABASE_URL', 'fetch:SESSION_SECRET']);
    expect(() => getServerConfig()).toThrow(/Required app credentials unavailable/);
    expect(mocks.postgres).not.toHaveBeenCalled();
    release();
    await boot;
    expect(mocks.events).toEqual([
      'fetch:identity', 'fetch:DATABASE_URL', 'fetch:SESSION_SECRET',
      'import:server', 'import:db-client', 'initialize:postgres', 'initialize:drizzle',
    ]);
    expect(mocks.postgres).toHaveBeenCalledWith(FAKE_DATABASE, { max: 1 });
    expect(Object.isFrozen(getServerConfig())).toBe(true);
    db.select();
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(db.query).toEqual({ TEST_ONLY_QUERY: true });
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.SESSION_SECRET).toBeUndefined();
    expect(await readdir(dir)).toEqual(['bootstrap.json']);
    const persisted = await readFile(join(dir, 'bootstrap.json'), 'utf8');
    expect(persisted).not.toContain(FAKE_DATABASE);
    expect(persisted).not.toContain(FAKE_SESSION);
    for (const method of ['warn', 'error', 'info', 'log', 'debug'] as const) {
      expect(console[method]).not.toHaveBeenCalled();
    }
    vi.resetModules();
    const copy = await import('../self-secrets');
    expect(copy.getServerConfig()).toBe(getServerConfig());
    const routeCopy = await import('../../db');
    routeCopy.db.select();
    expect(mocks.select).toHaveBeenCalledTimes(2);
    copy.clearSelfSecrets();
    expect(() => routeCopy.db.select).toThrow(/Required app credentials unavailable/);
  });

  it.each(['DATABASE_URL', 'SESSION_SECRET'])('fails closed when %s is missing despite legacy env entries', async (name) => {
    delete values[name];
    vi.stubEnv('DATABASE_URL', 'OBVIOUSLY_FAKE_ENV_DATABASE_IGNORED');
    vi.stubEnv('SESSION_SECRET', 'OBVIOUSLY_FAKE_ENV_SESSION_IGNORED');
    const { register } = await import('../../../instrumentation');
    const failure: Error = await register().catch((error: Error) => error) as Error;
    expect(failure.message).toMatch(/^Required app credentials unavailable:/);
    expect(failure.cause).toBeUndefined();
    expect(mocks.events).not.toContain('import:server');
    expect(mocks.postgres).not.toHaveBeenCalled();
    if (name === 'DATABASE_URL') expect(mocks.events).not.toContain('fetch:SESSION_SECRET');
    const { db } = await import('../../db');
    expect(() => db.select).toThrow(/Required app credentials unavailable/);
    const { isAppClaimed } = await import('../signing-identity');
    expect(isAppClaimed()).toBe(false);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('OBVIOUSLY_FAKE_ENV');
    expect(process.env.DATABASE_URL).toBe('OBVIOUSLY_FAKE_ENV_DATABASE_IGNORED');
  });

  it.each([
    ['DATABASE_URL', ''],
    ['DATABASE_URL', 'TEST_ONLY_NOT_A_URL'],
    ['DATABASE_URL', 'https://database.invalid'],
    ['DATABASE_URL', 'postgres:///TEST_ONLY'],
    ['SESSION_SECRET', ''],
    ['SESSION_SECRET', 'TEST_ONLY_SHORT'],
  ])('rejects invalid %s before importing the application server (%s)', async (name, value) => {
    values[name] = value;
    const { register } = await import('../../../instrumentation');
    await expect(register()).rejects.toThrow(/Required app credentials unavailable/);
    expect(mocks.events).not.toContain('import:server');
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it.each(['refused', 'tampered'])('fails closed with no provider values on a %s fetch', async (mode) => {
    refuse = mode === 'refused';
    if (mode === 'tampered') transform = (sealed) => ({ ...sealed, sealed: { ...sealed.sealed, encrypted: 'TEST_ONLY_INVALID_CIPHERTEXT' } });
    const { register } = await import('../../../instrumentation');
    const failure = await register().catch((error: Error) => error);
    expect(failure).toMatchObject({ message: expect.stringMatching(/^Required app credentials unavailable:/) });
    expect(String(failure)).not.toContain(FAKE_PROVIDER_ERROR);
    expect(mocks.events).not.toContain('import:server');
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('clears config and refuses stale DB access after server initialization fails', async () => {
    mocks.drizzle.mockImplementationOnce(() => { throw new Error(FAKE_PROVIDER_ERROR); });
    const { register } = await import('../../../instrumentation');
    await expect(register()).rejects.toThrow(/Required app credentials unavailable/);
    const { getServerConfig } = await import('../self-secrets');
    expect(() => getServerConfig()).toThrow(/Required app credentials unavailable/);
    const { db } = await import('../../db');
    expect(() => db.select).toThrow(/Required app credentials unavailable/);
    const { isAppClaimed } = await import('../signing-identity');
    expect(isAppClaimed()).toBe(false);
  });

  it('boots only the unclaimed shell without a keystore, never server/DB initialization', async () => {
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(dir, 'absent.json'));
    const { register } = await import('../../../instrumentation');
    await register();
    expect(mocks.events).toEqual([]);
    const { db } = await import('../../db');
    expect(() => db.select).toThrow(/Required app credentials unavailable/);
  });
});
