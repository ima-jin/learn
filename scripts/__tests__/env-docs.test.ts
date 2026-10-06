import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ENV_VAR_NAMES, ENV_VARS, validateEnv } from '../lib/env-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');
const CHECK_ENV = join(ROOT, 'scripts/check-env.mjs');

function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '__tests__', 'coverage', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function envNamesIn(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) names.add(match[1]);
  return [...names];
}

describe('env contract coverage', () => {
  const manifest = new Set(ENV_VAR_NAMES);

  it('has no duplicate manifest entries and every entry is complete', () => {
    expect(new Set(ENV_VAR_NAMES).size).toBe(ENV_VAR_NAMES.length);
    for (const variable of ENV_VARS) {
      expect(variable.summary.length, variable.name).toBeGreaterThan(10);
      expect(variable.dev, variable.name).toBeTruthy();
      expect(variable.prod, variable.name).toBeTruthy();
    }
  });

  it('documents every variable read by this repo (app, config, scripts)', () => {
    const files = [
      ...walk(join(ROOT, 'app')),
      ...walk(join(ROOT, 'src')),
      ...walk(join(ROOT, 'scripts')),
      join(ROOT, 'instrumentation.ts'),
      join(ROOT, 'next.config.js'),
      join(ROOT, 'drizzle.config.ts'),
      join(ROOT, 'ecosystem.config.cjs'),
    ];
    const undocumented = files.flatMap((file) =>
      envNamesIn(readFileSync(file, 'utf8'))
        .filter((name) => !manifest.has(name))
        .map((name) => `${name} (${file.replace(ROOT, '')})`),
    );
    expect(undocumented).toEqual([]);
  });

  it('documents every variable read by the installed @ima-jin/* packages', () => {
    const base = join(ROOT, 'node_modules/@ima-jin');
    const undocumented: string[] = [];
    for (const pkg of readdirSync(base)) {
      const dist = join(base, pkg, 'dist');
      for (const file of walk(dist)) {
        for (const name of envNamesIn(readFileSync(file, 'utf8'))) {
          if (!manifest.has(name)) undocumented.push(`${name} (@ima-jin/${pkg})`);
        }
      }
    }
    expect([...new Set(undocumented)]).toEqual([]);
  });

  it('lists every variable in .env.example and docs/ENVIRONMENTS.md', () => {
    const example = read('.env.example');
    const docs = read('docs/ENVIRONMENTS.md');
    for (const name of ENV_VAR_NAMES) {
      expect(example, `.env.example is missing ${name}`).toMatch(new RegExp(`^#?\\s*${name}=|^# ${name}\\b`, 'm'));
      expect(docs, `docs/ENVIRONMENTS.md is missing ${name}`).toContain(`\`${name}\``);
    }
  });

  it('shows both a dev and a prod example in docs/ENVIRONMENTS.md', () => {
    const docs = read('docs/ENVIRONMENTS.md');
    expect(docs).toContain('## Dev example');
    expect(docs).toContain('## Prod example');
    expect(docs).toContain(read('.env.dev.example').trim());
    expect(docs).toContain(read('.env.prod.example').trim());
  });

  it('keeps secrets out of every example file', () => {
    for (const file of ['.env.example', '.env.dev.example', '.env.prod.example']) {
      const parsed = parseEnv(read(file));
      for (const variable of ENV_VARS.filter((v) => v.secret)) {
        if (variable.name === 'DATABASE_URL') {
          expect(parsed.DATABASE_URL, file).toContain(':CHANGE_ME@');
        } else if (variable.name === 'SESSION_SECRET') {
          expect(parsed.SESSION_SECRET, file).toBe('REPLACE_ME');
        } else {
          expect(parsed[variable.name] ?? '', `${file} ${variable.name}`).toBe('');
        }
      }
    }
  });
});

const SECRET = 'a'.repeat(64);

/** A shipped example with every placeholder filled in the way an operator would. */
function filled(file: string) {
  return {
    ...parseEnv(read(file)),
    IMAJIN_APP_DID: 'did:imajin:abc123',
    NEXT_PUBLIC_IMAJIN_APP_ID: 'app_abc123',
    SESSION_SECRET: SECRET,
    DATABASE_URL: 'postgres://learn:s3cret@localhost:5432/imajin',
  };
}

describe('validateEnv', () => {
  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('accepts the shipped %s example apart from the placeholders', (target, file) => {
    const { errors } = validateEnv(parseEnv(read(file)), target);
    expect(errors).toHaveLength(4);
    expect(errors.join('\n')).toMatch(/IMAJIN_APP_DID is still a placeholder/);
    expect(errors.join('\n')).toMatch(/NEXT_PUBLIC_IMAJIN_APP_ID is still a placeholder/);
    expect(errors.join('\n')).toMatch(/SESSION_SECRET must be a real secret/);
    expect(errors.join('\n')).toMatch(/DATABASE_URL still contains a placeholder/);
  });

  it('accepts a fully filled-in file for each target', () => {
    for (const [target, file] of [['dev', '.env.dev.example'], ['prod', '.env.prod.example']] as const) {
      expect(validateEnv(filled(file), target)).toEqual({ errors: [], warnings: [] });
    }
  });

  const validProd = () => filled('.env.prod.example');
  const validDev = () => filled('.env.dev.example');
  const errorsOf = (env: Record<string, string | undefined>, target: 'prod' | 'dev') => validateEnv(env, target).errors.join('\n');

  it('reports every missing required variable by name', () => {
    const { errors } = validateEnv({}, 'prod');
    for (const variable of ENV_VARS.filter((v) => v.status === 'required')) {
      expect(errors).toContain(`${variable.name} is required but not set.`);
    }
  });

  it('rejects a raw private key', () => {
    expect(errorsOf({ ...validProd(), IMAJIN_APP_PRIVATE_KEY: 'x' }, 'prod')).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
  });

  it('keeps dev and prod apart', () => {
    expect(errorsOf({ ...validProd(), IMAJIN_ENV: 'dev' }, 'prod')).toMatch(/IMAJIN_ENV=dev must not be set on prod/);
    expect(errorsOf({ ...validProd(), AUTH_SERVICE_URL: 'https://dev-jin.imajin.ai/auth' }, 'prod')).toMatch(/dev host/);
    expect(errorsOf({ ...validDev(), IMAJIN_ENV: '' }, 'dev')).toMatch(/IMAJIN_ENV must be `dev`/);
    expect(errorsOf({ ...validDev(), IMAJIN_KERNEL_URL: 'https://jin.imajin.ai' }, 'dev')).toMatch(/non-dev host/);
    expect(errorsOf({ ...validDev(), NEXT_PUBLIC_SERVICE_PREFIX: 'https://' }, 'dev')).toMatch(/NEXT_PUBLIC_SERVICE_PREFIX must be https:\/\/dev-/);
    expect(errorsOf({ ...validProd(), NEXT_PUBLIC_SERVICE_PREFIX: 'https://dev-' }, 'prod')).toMatch(/NEXT_PUBLIC_SERVICE_PREFIX must be https:\/\//);
  });

  it('rejects localhost kernels, mismatched kernel hosts and missing service prefixes', () => {
    expect(errorsOf({ ...validProd(), IMAJIN_KERNEL_URL: 'http://localhost:3000' }, 'prod')).toMatch(/localhost/);
    expect(errorsOf({ ...validProd(), PROFILE_SERVICE_URL: 'https://other.imajin.ai/profile' }, 'prod')).toMatch(/same kernel host/);
    expect(errorsOf({ ...validProd(), AUTH_SERVICE_URL: 'https://jin.imajin.ai' }, 'prod')).toMatch(/\/auth prefix/);
    expect(errorsOf({ ...validProd(), REGISTRY_SERVICE_URL: 'https://jin.imajin.ai/auth' }, 'prod')).toMatch(/\/registry prefix/);
    expect(errorsOf({ ...validProd(), PAY_SERVICE_URL: 'https://jin.imajin.ai' }, 'prod')).toMatch(/\/pay prefix/);
    expect(errorsOf({ ...validProd(), AUTH_SERVICE_URL: 'not a url' }, 'prod')).toMatch(/not a valid http/);
  });

  it('rejects a wrong schema, base path, database URL, DID, app id and a weak session secret', () => {
    const errors = errorsOf(
      {
        ...validProd(),
        APP_DB_SCHEMA: 'other',
        NEXT_PUBLIC_BASE_PATH: '/x',
        DATABASE_URL: 'mysql://h/db',
        IMAJIN_APP_DID: 'abc',
        NEXT_PUBLIC_IMAJIN_APP_ID: 'xyz',
        SESSION_SECRET: 'short',
      },
      'prod',
    );
    expect(errors).toMatch(/APP_DB_SCHEMA must be `learn`/);
    expect(errors).toMatch(/NEXT_PUBLIC_BASE_PATH must be \/learn/);
    expect(errors).toMatch(/DATABASE_URL must be a postgres/);
    expect(errors).toMatch(/must start with did:imajin:/);
    expect(errors).toMatch(/must be the registry id/);
    expect(errors).toMatch(/SESSION_SECRET must be a real secret/);
  });

  it('warns (without failing) about first-boot, port and logging leftovers', () => {
    const { errors, warnings } = validateEnv(
      { ...validProd(), IMAJIN_APP_CLAIM_CODE: 'once', PORT: '9999', LOG_DB_TRANSPORT: 'true' },
      'prod',
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/IMAJIN_APP_CLAIM_CODE is set/);
    expect(warnings.join('\n')).toMatch(/PORT is set/);
    expect(warnings.join('\n')).toMatch(/LOG_DB_TRANSPORT=true/);
  });

  it('needs a claim code on a first boot (no keystore), and only then', () => {
    const firstBoot = validateEnv(validProd(), 'prod', { keystoreExists: false });
    expect(firstBoot.errors.join('\n')).toMatch(/No keystore found and IMAJIN_APP_CLAIM_CODE is not set/);

    expect(validateEnv({ ...validProd(), IMAJIN_APP_CLAIM_CODE: 'once' }, 'prod', { keystoreExists: false }).errors).toEqual([]);
    expect(validateEnv(validProd(), 'prod', { keystoreExists: true })).toEqual({ errors: [], warnings: [] });
  });

  it('throws on an unknown target', () => {
    expect(() => validateEnv({}, 'staging' as never)).toThrow(/Unknown target/);
  });
});

describe('check-env CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-check-env-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (args: string[]) => spawnSync(process.execPath, [CHECK_ENV, ...args], { env: childEnv(), encoding: 'utf8', cwd: dir });
  const filledText = (file: string, keystore: string) =>
    `${Object.entries({ ...filled(file), IMAJIN_APP_KEYSTORE: keystore })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`;

  it('exits 0 for a valid file with an existing keystore and prints names/messages only', () => {
    const keystore = join(dir, 'keystore.json');
    writeFileSync(keystore, '{}');
    const file = join(dir, 'ok.env');
    writeFileSync(file, filledText('.env.prod.example', keystore));
    const result = cli(['prod', '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/is valid for prod/);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  it('exits 1 on a first boot (no keystore, no claim code) without echoing any value', () => {
    const file = join(dir, 'firstboot.env');
    writeFileSync(file, filledText('.env.dev.example', join(dir, 'does-not-exist.json')));
    const result = cli(['dev', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No keystore found and IMAJIN_APP_CLAIM_CODE is not set/);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  it('exits 0 on a first boot once the claim code is present, warning to remove it afterwards', () => {
    const file = join(dir, 'claim.env');
    writeFileSync(file, `${filledText('.env.dev.example', join(dir, 'does-not-exist.json'))}IMAJIN_APP_CLAIM_CODE=one-time-code\n`);
    const result = cli(['dev', '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/IMAJIN_APP_CLAIM_CODE is set/);
    expect(result.stdout + result.stderr).not.toContain('one-time-code');
  });

  it('exits 1 for an invalid file without echoing any value', () => {
    const file = join(dir, 'bad.env');
    writeFileSync(file, 'DATABASE_URL=postgres://u:supersecretvalue@h/db\nIMAJIN_APP_PRIVATE_KEY=supersecretkey\n');
    const result = cli(['prod', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
    expect(result.stdout + result.stderr).not.toContain('supersecret');
  });

  it('exits 2 on a missing file, an unknown target, and stray arguments', () => {
    expect(cli(['prod', '--file', join(dir, 'nope.env')]).status).toBe(2);
    expect(cli(['staging']).status).toBe(2);
    expect(cli(['prod', '--wat']).status).toBe(2);
  });
});
