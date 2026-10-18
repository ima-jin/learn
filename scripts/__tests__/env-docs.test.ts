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
  it('declares only names/kinds, importing the database while retaining generated session credentials', () => {
    expect(JSON.parse(read('imajin.app.json')).secrets).toEqual([
      { name: 'DATABASE_URL', kind: 'operator-supplied' },
      { name: 'SESSION_SECRET', kind: 'random-32B' },
    ]);
    expect(ENV_VAR_NAMES).not.toContain('SESSION_SECRET');
    for (const file of [
      '.env.example', '.env.dev.example', '.env.prod.example',
      'scripts/lib/env-manifest.mjs', 'scripts/check-env.mjs',
      'README.md', 'docs/REGISTRATION.md', 'docs/DEPLOY.md', 'docs/ENVIRONMENTS.md',
    ]) {
      expect(read(file), file).not.toMatch(/^\s*(SESSION_SECRET|WEBHOOK_SECRET)=/m);
    }
    const dependencies = JSON.parse(read('package.json')).dependencies;
    expect(dependencies['@ima-jin/auth']).toBe('0.8.18');
    expect(dependencies['@ima-jin/auth-client']).toBe('0.8.24');
  });

  it('documents kernel-first deployment and manifest Sync separately for each environment', () => {
    const docs = read('docs/DEPLOY.md');
    const section = docs.split('## Vault self-secret rollout order')[1].split('## Kernel-signed callback rollout order')[0];
    expect(section).toContain('separately on **each environment**');
    expect(section).toContain('ima-jin/imajin-ai#2801');
    expect(section).toContain('Sync the manifest secrets on `/jin`');
    expect(section.indexOf('#2801')).toBeLessThan(section.indexOf('Sync the manifest secrets'));
    expect(section.indexOf('Sync the manifest secrets')).toBeLessThan(section.indexOf('Only then upgrade this app'));
    expect(section).toContain('a claimed app fails closed at boot');
  });
  it('documents vault-backed migrations and intentional names-only webhook audit text', () => {
    expect(read('docs/ENVIRONMENTS.md')).toContain('there is no current `WEBHOOK_SECRET` consumer');
    for (const file of ['README.md', 'docs/DEPLOY.md', 'docs/MIGRATIONS.md', 'docs/ENVIRONMENTS.md']) {
      expect(read(file), file).not.toContain('#2241');
    }
    expect(read('docs/DEPLOY.md')).toContain('scripts/migrate.mjs');
    expect(read('docs/MIGRATIONS.md')).toContain('neither entry point reads `process.env.DATABASE_URL`');
    expect(read('drizzle.config.ts')).not.toContain('dbCredentials');
    expect(JSON.parse(read('package.json')).scripts['db:migrate']).toContain('scripts/migrate.mjs');
  });
  it('keeps IMAJIN_APP_CLAIM_CODE absent outside tests asserting its removal or ignored behavior', () => {
    const files = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n');
    const assertionFiles = new Set([
      'scripts/__tests__/env-docs.test.ts',
      'src/lib/__tests__/signing-identity.test.ts',
    ]);
    for (const file of files) {
      if (assertionFiles.has(file)) continue;
      expect(read(file), file).not.toContain('IMAJIN_APP_CLAIM_CODE');
    }
  });

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
          // The SDK's legacy env claim default is disabled by our explicit options.
          if (name === 'IMAJIN_APP_CLAIM_CODE' || name === 'SESSION_SECRET') continue;
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
        expect(parsed[variable.name] ?? '', `${file} ${variable.name}`).toBe('');
      }
    }
  });
});


/** A shipped example with every placeholder filled in the way an operator would. */
function filled(file: string) {
  return {
    ...parseEnv(read(file)),
    IMAJIN_APP_DID: 'did:imajin:abc123',
    NEXT_PUBLIC_IMAJIN_APP_ID: 'app_abc123',
  };
}

describe('validateEnv', () => {
  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('accepts the shipped %s example apart from the placeholders', (target, file) => {
    const { errors } = validateEnv(parseEnv(read(file)), target);
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/IMAJIN_APP_DID is still a placeholder/);
    expect(errors.join('\n')).toMatch(/NEXT_PUBLIC_IMAJIN_APP_ID is still a placeholder/);
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

  it('rejects a wrong schema, base path, database URL, DID and app id', () => {
    const errors = errorsOf(
      {
        ...validProd(),
        APP_DB_SCHEMA: 'other',
        NEXT_PUBLIC_BASE_PATH: '/x',
        DATABASE_URL: 'mysql://h/db',
        IMAJIN_APP_DID: 'abc',
        NEXT_PUBLIC_IMAJIN_APP_ID: 'xyz',
      },
      'prod',
    );
    expect(errors).toMatch(/APP_DB_SCHEMA must be `learn`/);
    expect(errors).toMatch(/NEXT_PUBLIC_BASE_PATH must be \/learn/);
    expect(errors).toMatch(/DATABASE_URL must not be set/);
    expect(errors).toMatch(/must start with did:imajin:/);
    expect(errors).toMatch(/must be the registry id/);
  });

  it('warns (without failing) about port and logging leftovers', () => {
    const { errors, warnings } = validateEnv(
      { ...validProd(), PORT: '9999', LOG_DB_TRANSPORT: 'true' },
      'prod',
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/PORT is set/);
    expect(warnings.join('\n')).toMatch(/LOG_DB_TRANSPORT=true/);
  });

  it('only warns on a first boot (no keystore, no claim code) — claim at /learn/claim after boot', () => {
    const firstBoot = validateEnv(validProd(), 'prod', { keystoreExists: false });
    expect(firstBoot.errors).toEqual([]);
    expect(firstBoot.warnings.join('\n')).toMatch(/No keystore found/);
    expect(firstBoot.warnings.join('\n')).toMatch(/claim at \/learn\/claim after boot/);

    const withIgnoredCode = validateEnv({ ...validProd(), IMAJIN_APP_CLAIM_CODE: 'FAKE_ENV_CLAIM_CODE_IGNORED' }, 'prod', { keystoreExists: false });
    expect(withIgnoredCode).toEqual(firstBoot);
    expect(ENV_VAR_NAMES).not.toContain('IMAJIN_APP_CLAIM_CODE');
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
    expect(result.stdout + result.stderr).not.toContain('FAKE_TEST_PASSWORD');
  });

  it('exits 0 on a first boot (no keystore, no claim code), warning to claim at /learn/claim, without echoing any value', () => {
    const file = join(dir, 'firstboot.env');
    writeFileSync(file, filledText('.env.dev.example', join(dir, 'does-not-exist.json')));
    const result = cli(['dev', '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/No keystore found/);
    expect(result.stderr).toMatch(/claim at \/learn\/claim after boot/);
    expect(result.stderr).not.toMatch(/^error:/m);
    expect(result.stdout + result.stderr).not.toContain('FAKE_TEST_PASSWORD');
  });

  it('ignores the legacy env claim code and still directs first boot to the browser', () => {
    const file = join(dir, 'claim.env');
    writeFileSync(file, `${filledText('.env.dev.example', join(dir, 'does-not-exist.json'))}IMAJIN_APP_CLAIM_CODE=FAKE_ENV_CLAIM_CODE_IGNORED\n`);
    const result = cli(['dev', '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/claim at \/learn\/claim after boot/);
    expect(result.stdout + result.stderr).not.toContain('IMAJIN_APP_CLAIM_CODE');
    expect(result.stdout + result.stderr).not.toContain('FAKE_ENV_CLAIM_CODE_IGNORED');
  });

  it('exits 1 for an invalid file without echoing any value', () => {
    const file = join(dir, 'bad.env');
    writeFileSync(file, 'DATABASE_URL=OBVIOUSLY_FAKE_LEGACY_DATABASE_VALUE\nIMAJIN_APP_PRIVATE_KEY=OBVIOUSLY_FAKE_LEGACY_PRIVATE_VALUE\n');
    const result = cli(['prod', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
    expect(result.stderr).toMatch(/DATABASE_URL must not be set/);
    expect(result.stdout + result.stderr).not.toContain('OBVIOUSLY_FAKE_LEGACY');
  });

  it('exits 2 on a missing file, an unknown target, and stray arguments', () => {
    expect(cli(['prod', '--file', join(dir, 'nope.env')]).status).toBe(2);
    expect(cli(['staging']).status).toBe(2);
    expect(cli(['prod', '--wat']).status).toBe(2);
  });
});
