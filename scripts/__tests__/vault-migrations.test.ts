import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  canonicalizeAppSecretFetchPayload, generateBootstrapKeypair, signBootstrapPayload, writeKeystore,
  type AppSecretFetchPayload,
} from '@ima-jin/auth-client';
import { deriveXKeypairFromEd25519, sealSecret, wrapFieldKey } from '@ima-jin/vault-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../lib/env-manifest.mjs';
import { main as baseline } from '../migrate-baseline.mjs';
import { main as migrate } from '../migrate.mjs';

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(), end: vi.fn(), runBaseline: vi.fn(), migrate: vi.fn(), drizzle: vi.fn(),
}));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: mocks.migrate }));
vi.mock('../lib/migrate-baseline-core.mjs', async (original) => ({
  ...await original<typeof import('../lib/migrate-baseline-core.mjs')>(),
  runBaseline: mocks.runBaseline,
}));

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_DATABASE = 'postgres://database.invalid/TEST_ONLY_VAULT_DATABASE';
const FAKE_CI_DATABASE = 'postgres://database.invalid/TEST_ONLY_CI_DATABASE';
const FAKE_ERROR = 'OBVIOUSLY_FAKE_PROVIDER_VALUE_MUST_NOT_ESCAPE';
const bootstrap = generateBootstrapKeypair();
const sender = deriveXKeypairFromEd25519(generateBootstrapKeypair().privateKey, 'TEST_ONLY_MIGRATION_SENDER');
const entries = [['baseline', baseline], ['migrate', migrate]] as const;
let dir: string;
let settings: Record<string, string | undefined>;
let fetched: ReturnType<typeof vi.fn>;

function sealedResponse(request: AppSecretFetchPayload, value?: string) {
  const key = randomBytes(32);
  try {
    const values = value === undefined ? {} : { DATABASE_URL: value };
    return Response.json({
      version: 1, senderXPub: sender.publicKey,
      wrappedKey: wrapFieldKey(key, request.recipientXPub, sender.privateKey),
      sealed: sealSecret(JSON.stringify({
        domain: request.domain, appDid: request.appDid, nonce: request.nonce, keys: request.keys,
        values, missing: value === undefined ? ['DATABASE_URL'] : [],
      }), key),
    });
  } finally {
    key.fill(0);
  }
}

beforeEach(async () => {
  vi.resetAllMocks();
  dir = await mkdtemp(join(tmpdir(), 'learn-migration-vault-'));
  const keystorePath = join(dir, 'bootstrap.json');
  writeKeystore(keystorePath, bootstrap);
  settings = {
    ...parseEnv(await readFile(join(ROOT, '.env.prod.example'), 'utf8')),
    IMAJIN_APP_DID: 'did:imajin:learn-test',
    NEXT_PUBLIC_IMAJIN_APP_ID: 'app_test',
    IMAJIN_APP_KEYSTORE: keystorePath,
  };
  mocks.end.mockResolvedValue(undefined);
  mocks.postgres.mockReturnValue({ end: mocks.end });
  mocks.runBaseline.mockResolvedValue({ status: 'fresh-database' });
  mocks.drizzle.mockReturnValue({ TEST_ONLY_DB: true });
  mocks.migrate.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetched = vi.fn(async (url: URL, init: RequestInit) => {
    expect(String(url)).toBe('https://jin.imajin.ai/api/apps/secrets/fetch');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    const request = JSON.parse(String(init.body)) as AppSecretFetchPayload & { signature: string };
    expect(request).toMatchObject({ appDid: settings.IMAJIN_APP_DID, keys: ['DATABASE_URL'] });
    expect(request.signature).toBe(signBootstrapPayload(canonicalizeAppSecretFetchPayload(request), bootstrap.privateKey));
    return sealedResponse(request, FAKE_DATABASE);
  });
  vi.stubGlobal('fetch', fetched);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Also exercise default process.env entry-point arguments; any legacy lookup throws. */
function guardProcessEnv() {
  const reads: string[] = [];
  const env = new Proxy(settings, {
    get(target, property) {
      reads.push(String(property));
      if (property === 'DATABASE_URL') throw new Error('TEST_ONLY_FORBIDDEN_ENV_READ');
      return Reflect.get(target, property);
    },
  });
  vi.stubGlobal('process', new Proxy(process, {
    get(target, property) {
      return property === 'env' ? env : Reflect.get(target, property);
    },
  }));
  return reads;
}

describe('vault-backed deployment migration entry points', () => {
  it('passes check-env and both migration entry points with the same file and no DATABASE_URL', async () => {
    expect(settings).not.toHaveProperty('DATABASE_URL');
    expect(settings).not.toHaveProperty('MIGRATIONS_TEST_DATABASE_URL');
    expect(validateEnv(settings, 'prod')).toEqual({ errors: [], warnings: [] });
    const file = join(dir, 'settings.env');
    await writeFile(file, Object.entries(settings).map(([name, value]) => `${name}=${value}`).join('\n'));
    const check = spawnSync(process.execPath, [join(ROOT, 'scripts/check-env.mjs'), 'prod', '--file', file], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8',
    });
    expect(check.status).toBe(0);
    settings = parseEnv(await readFile(file, 'utf8'));
    const reads = guardProcessEnv();
    expect(await baseline([])).toBe(0);
    expect(await migrate([])).toBe(0);
    expect(reads).not.toContain('DATABASE_URL');
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
    expect(mocks.postgres).toHaveBeenCalledWith(FAKE_DATABASE, expect.objectContaining({ max: 1 }));
    expect(mocks.runBaseline).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ schema: 'learn', dryRun: false }),
    );
    expect(mocks.migrate).toHaveBeenCalledWith({ TEST_ONLY_DB: true }, {
      migrationsFolder: join(ROOT, 'migrations'),
      migrationsSchema: 'learn', migrationsTable: '__drizzle_migrations',
    });
    expect(mocks.end).toHaveBeenCalledTimes(2);
    expect(await readFile(file, 'utf8')).not.toContain(FAKE_DATABASE);
    expect(settings).not.toHaveProperty('DATABASE_URL');
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(FAKE_DATABASE);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(entries)('%s ignores even a present legacy env value rather than reading it', async (_name, entry) => {
    settings.DATABASE_URL = 'OBVIOUSLY_FAKE_ENV_DATABASE_IGNORED';
    const reads = guardProcessEnv();
    expect(await entry([])).toBe(0);
    expect(reads).not.toContain('DATABASE_URL');
    expect(mocks.postgres).toHaveBeenCalledWith(FAKE_DATABASE, expect.anything());
  });

  it.each(entries)('%s fails closed on vault failure with no env fallback or provider details', async (_name, entry) => {
    settings.DATABASE_URL = 'OBVIOUSLY_FAKE_ENV_DATABASE_IGNORED';
    fetched.mockRejectedValue(new Error(FAKE_ERROR));
    const reads = guardProcessEnv();
    expect(await entry([])).toBe(2);
    expect(reads).not.toContain('DATABASE_URL');
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(mocks.runBaseline).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No env fallback'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/OBVIOUSLY_FAKE/);
  });

  it.each(entries)('%s refuses missing or invalid sealed credentials before constructing Postgres', async (_name, entry) => {
    for (const value of [undefined, '', 'TEST_ONLY_NOT_A_URL', 'https://database.invalid']) {
      fetched.mockImplementation(async (_url: URL, init: RequestInit) => sealedResponse(JSON.parse(String(init.body)), value));
      expect(await entry([], settings)).toBe(2);
    }
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/TEST_ONLY/);
  });

  it.each(entries)('%s uses only the explicit CI database switch and skips vault', async (_name, entry) => {
    settings.MIGRATIONS_TEST_DATABASE_URL = FAKE_CI_DATABASE;
    const reads = guardProcessEnv();
    expect(await entry([])).toBe(0);
    expect(fetched).not.toHaveBeenCalled();
    expect(reads).not.toContain('DATABASE_URL');
    expect(mocks.postgres).toHaveBeenCalledWith(FAKE_CI_DATABASE, expect.anything());
  });

  it.each(entries)('%s fails closed if the explicit CI switch is empty', async (_name, entry) => {
    settings.MIGRATIONS_TEST_DATABASE_URL = '';
    expect(await entry([], settings)).toBe(2);
    expect(fetched).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it.each(entries)('%s sanitizes constructor, database and cleanup failures', async (name, entry) => {
    const operations = [mocks.postgres, mocks.end, name === 'baseline' ? mocks.runBaseline : mocks.migrate];
    for (const operation of operations) {
      operation.mockImplementationOnce(() => { throw new Error(FAKE_ERROR); });
      expect(await entry([], settings)).toBe(2);
    }
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(FAKE_ERROR);
  });

  it.each(entries)('%s rejects bad arguments and unsafe schemas before fetching credentials', async (_name, entry) => {
    expect(await entry(['--force'], settings)).toBe(2);
    expect(await entry([], { ...settings, APP_DB_SCHEMA: 'TEST_ONLY_UNSAFE;schema' })).toBe(2);
    expect(fetched).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it('preserves the baseline dry-run option and schema-mismatch refusal status', async () => {
    expect(await baseline(['--dry-run'], settings)).toBe(0);
    expect(mocks.runBaseline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }));
    const { BaselineMismatchError } = await import('../lib/migrate-baseline-core.mjs');
    mocks.runBaseline.mockRejectedValueOnce(new BaselineMismatchError(['courses: table is missing']));
    expect(await baseline([], settings)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Nothing was changed'));
  });
});
