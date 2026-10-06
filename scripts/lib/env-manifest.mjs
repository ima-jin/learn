/**
 * Single source of truth for every environment variable this app (or a
 * dependency it loads, or one of its scripts) reads — refs
 * ima-jin/imajin-ai#2504. Consumed by:
 *   - scripts/check-env.mjs            (deploy preflight; never prints values)
 *   - scripts/__tests__/env-docs.test.ts (fails CI if .env.example or
 *     docs/ENVIRONMENTS.md omit a variable, or if code starts reading one
 *     that is not listed here)
 *
 * Examples here are shape-only placeholders — never real secrets.
 */
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';

export const TARGETS = {
  prod: { name: 'prod-learn', port: 7103 },
  dev: { name: 'dev-learn', port: 3103 },
};

export const BASE_PATH = '/learn';

/**
 * status:
 *   required         must be set in the env file for a deployed instance
 *   first-boot       required only on the very first boot, then removed
 *   optional         read, has a safe default when unset
 *   forbidden        must NOT be set (the app refuses to boot if it is)
 *   runtime-set      injected by Next.js / pm2 — not set in the env file
 *   dependency       read by an @ima-jin/* dependency on a code path learn
 *                    does not exercise; leave unset
 * phase: 'build' = baked into the build (set before `next build`),
 *        'runtime' = read at process start / request time,
 *        'script' = read only by an operator/CI script.
 */
export const ENV_VARS = [
  {
    name: 'DATABASE_URL',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary: "Postgres connection string for this app's own database (also read by drizzle-kit and scripts/migrate-baseline.mjs).",
    dev: 'postgres://<role>:<password>@localhost:5432/<dev_db>',
    prod: 'postgres://<role>:<password>@localhost:5432/<prod_db>',
  },
  {
    name: 'APP_DB_SCHEMA',
    status: 'required',
    phase: 'runtime',
    summary: 'The one Postgres schema this app owns. Fixed to `learn` — the existing prod/dev schema; never change it.',
    dev: 'learn',
    prod: 'learn',
  },
  {
    name: 'SESSION_SECRET',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary: 'HS256 key for the session cookie (@ima-jin/auth-client). 32+ random characters, e.g. `openssl rand -hex 32`; separate per environment.',
    dev: '(32+ random chars)',
    prod: '(32+ random chars)',
  },
  {
    name: 'IMAJIN_AUTH_URL',
    status: 'required',
    phase: 'runtime',
    summary: 'Kernel base URL (no path) the session helpers use for sign-in/session validation.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'AUTH_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary: 'Kernel auth service base URL, including the /auth prefix. Verifies scoped app tokens and receives learn.* attestations.',
    dev: 'https://dev-jin.imajin.ai/auth',
    prod: 'https://jin.imajin.ai/auth',
  },
  {
    name: 'IMAJIN_KERNEL_URL',
    status: 'required',
    phase: 'runtime',
    summary: "Kernel base URL (no path). Used to fetch this app's signing key at boot (claim / keystore) and as the PAY_SERVICE_URL fallback.",
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'REGISTRY_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary: "Kernel registry service base URL, including /registry. Course creation reads the node's .fair fee config from its public node/self route.",
    dev: 'https://dev-jin.imajin.ai/registry',
    prod: 'https://jin.imajin.ai/registry',
  },
  {
    name: 'PROFILE_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary: "Kernel profile service base URL, including /profile. Batched DID -> handle/name for the creator's student roster; called with NO credential.",
    dev: 'https://dev-jin.imajin.ai/profile',
    prod: 'https://jin.imajin.ai/profile',
  },
  {
    name: 'PAY_SERVICE_URL',
    status: 'optional',
    phase: 'runtime',
    summary: 'Kernel pay service base URL, including /pay — paid-course checkout. Defaults to $IMAJIN_KERNEL_URL/pay when unset.',
    dev: 'https://dev-jin.imajin.ai/pay',
    prod: 'https://jin.imajin.ai/pay',
  },
  {
    name: 'NEXT_PUBLIC_BASE_PATH',
    status: 'required',
    phase: 'build',
    summary: 'Reverse-proxy path prefix the app is mounted under. Must be `/learn` (the Caddy route forwards it intact). Baked at build time; rebuild after changing.',
    dev: '/learn',
    prod: '/learn',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    status: 'required',
    phase: 'build',
    summary:
      "This app's public URL. Its HOST is the `aud` used to verify scoped app tokens — it must match a host in this app's registered tokenAudiences (operator-confirmed at registration). Baked at build time.",
    dev: 'https://dev-jin.imajin.ai/learn',
    prod: 'https://jin.imajin.ai/learn',
  },
  {
    name: 'NEXT_PUBLIC_IMAJIN_AUTH_URL',
    status: 'required',
    phase: 'build',
    summary: 'Kernel base URL exposed to the browser — builds the "Sign in with Imajin" redirect. Same value as IMAJIN_AUTH_URL.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'NEXT_PUBLIC_IMAJIN_APP_ID',
    status: 'required',
    phase: 'build',
    summary: "This app's public registry id (`app_…`), returned by registration. Used client-side in the sign-in redirect — safe to expose.",
    dev: 'app_<dev registry id>',
    prod: 'app_<prod registry id>',
  },
  {
    name: 'NEXT_PUBLIC_SERVICE_PREFIX',
    status: 'required',
    phase: 'build',
    summary: 'Read by @ima-jin/config buildPublicUrl() for links to other Imajin apps (pay Connect check, events banner). `https://` on prod, `https://dev-` on dev.',
    dev: 'https://dev-',
    prod: 'https://',
  },
  {
    name: 'NEXT_PUBLIC_DOMAIN',
    status: 'required',
    phase: 'build',
    summary: 'Companion to NEXT_PUBLIC_SERVICE_PREFIX: the platform domain.',
    dev: 'imajin.ai',
    prod: 'imajin.ai',
  },
  {
    name: 'IMAJIN_APP_DID',
    status: 'required',
    phase: 'runtime',
    summary: "This app's own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret.",
    dev: 'did:imajin:<dev app DID>',
    prod: 'did:imajin:<prod app DID>',
  },
  {
    name: 'IMAJIN_APP_CLAIM_CODE',
    status: 'first-boot',
    phase: 'runtime',
    secret: true,
    summary:
      "One-time code from the kernel operator's /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot. check-env fails while there is neither a keystore nor a claim code.",
    dev: '(only on first boot)',
    prod: '(only on first boot)',
  },
  {
    name: 'IMAJIN_APP_KEYSTORE',
    status: 'optional',
    phase: 'runtime',
    summary:
      "Path of this app's 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod.",
    dev: '/home/jin/.imajin/learn.dev.keystore.json',
    prod: '/home/jin/.imajin/learn.prod.keystore.json',
  },
  {
    name: 'IMAJIN_APP_PRIVATE_KEY',
    status: 'forbidden',
    phase: 'runtime',
    secret: true,
    summary: 'Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env.',
    dev: '(never set)',
    prod: '(never set)',
  },
  {
    name: 'IMAJIN_ENV',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Selects the kernel session cookie name in @ima-jin/config: `dev` → imajin_session_dev, anything else → imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod.',
    dev: 'dev',
    prod: '(unset)',
  },
  {
    name: 'PORT',
    status: 'runtime-set',
    phase: 'runtime',
    summary: 'Listen port. Set by the pm2 ecosystem entry (prod 7103, dev 3103); only used directly by `pnpm dev`.',
    dev: '3103',
    prod: '7103',
  },
  {
    name: 'NODE_ENV',
    status: 'runtime-set',
    phase: 'runtime',
    summary: 'Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file.',
    dev: 'production',
    prod: 'production',
  },
  {
    name: 'NEXT_RUNTIME',
    status: 'runtime-set',
    phase: 'runtime',
    summary: 'Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand.',
    dev: '(set by Next.js)',
    prod: '(set by Next.js)',
  },
  {
    name: 'LOG_LEVEL',
    status: 'optional',
    phase: 'runtime',
    summary: 'pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it.',
    dev: 'debug',
    prod: 'info',
  },
  {
    name: 'ENABLE_REQUEST_LOG',
    status: 'optional',
    phase: 'runtime',
    summary: 'Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only).',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'ENABLE_APP_LOG',
    status: 'optional',
    phase: 'runtime',
    summary: 'Logger persisted-log switch. Leave unset: this app never persists logs to a database.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'LOG_DB_TRANSPORT',
    status: 'optional',
    phase: 'runtime',
    summary: 'Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md).',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'APP_LOG_LEVEL',
    status: 'optional',
    phase: 'runtime',
    summary: 'Minimum level the logger would persist (default warn). Inert while persistence is off.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'ATTESTATION_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary: '@ima-jin/auth act-as / service attestation calls. learn attests with its own delegated app key instead; leave unset. Never hand-mint it.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'AUTH_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary: 'Deprecated @ima-jin/auth internal key (agent delegation). Not used by learn; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'PROFILE_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary: '@ima-jin/auth credential resolution key. learn holds no service-scope secret by design (emails are never released to it); leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NODE_DID',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth node-act-as check (kernel node DID). Not used by learn; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'APP_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth fallback origin for redirects. learn does not rely on it; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_BASE_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/auth fallback origin for redirects (after APP_URL). learn does not rely on it; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'REGISTRY_URL',
    status: 'dependency',
    phase: 'runtime',
    summary: 'Deprecated alias of REGISTRY_SERVICE_URL read by @ima-jin/config. Leave unset; use REGISTRY_SERVICE_URL.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'SESSION_COOKIE_SCOPE',
    status: 'dependency',
    phase: 'runtime',
    summary: '@ima-jin/config session-cookie scope switch (default host-only). Leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_BUILD_HASH',
    status: 'dependency',
    phase: 'build',
    summary: '@ima-jin/ui footer build stamp. Cosmetic; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_COMMIT_COUNT',
    status: 'dependency',
    phase: 'build',
    summary: '@ima-jin/ui footer build stamp. Cosmetic; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_VERSION',
    status: 'dependency',
    phase: 'build',
    summary: '@ima-jin/ui footer version stamp. Cosmetic; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_NOTIFY_URL',
    status: 'dependency',
    phase: 'build',
    summary: '@ima-jin/ui notification widget endpoint. learn renders no such widget; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'MIGRATIONS_TEST_DATABASE_URL',
    status: 'optional',
    phase: 'script',
    secret: true,
    summary: 'CI/test only: a throwaway Postgres server the migration tests create scratch databases on. Never used in deployment.',
    dev: '(unset)',
    prod: '(unset)',
  },
];

export const ENV_VAR_NAMES = ENV_VARS.map((v) => v.name);

const PLACEHOLDER = /REPLACE_ME|CHANGE_ME/;
const MIN_SESSION_SECRET_LENGTH = 32;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

function checkKernelUrl(name, value, target, errors) {
  const url = parseUrl(value);
  if (url === null || !/^https?:$/.test(url.protocol)) {
    errors.push(`${name} is not a valid http(s) URL.`);
    return;
  }
  if (isLocalHost(url.hostname)) {
    errors.push(`${name} points at localhost — a deployed ${target} instance must use the real kernel host.`);
    return;
  }
  const isDevHost = url.hostname.startsWith('dev-');
  if (target === 'prod' && isDevHost) {
    errors.push(`${name} points at a dev host (${url.hostname}) in a prod env file.`);
  }
  if (target === 'dev' && !isDevHost) {
    errors.push(`${name} points at a non-dev host (${url.hostname}) in a dev env file — dev must never talk to the prod kernel.`);
  }
}

function checkServicePrefix(name, value, prefix, errors) {
  if (value === '') return;
  const path = (parseUrl(value)?.pathname ?? '').replace(/\/$/, '');
  if (path !== prefix) {
    errors.push(`${name} must include the ${prefix} prefix (and nothing after it).`);
  }
}

const KERNEL_URL_VARS = [
  'IMAJIN_AUTH_URL',
  'NEXT_PUBLIC_IMAJIN_AUTH_URL',
  'IMAJIN_KERNEL_URL',
  'AUTH_SERVICE_URL',
  'REGISTRY_SERVICE_URL',
  'PROFILE_SERVICE_URL',
  'PAY_SERVICE_URL',
];

function checkIdentity(get, errors) {
  const did = get('IMAJIN_APP_DID');
  if (did !== '' && !did.startsWith('did:imajin:')) {
    errors.push('IMAJIN_APP_DID must start with did:imajin:.');
  }
  if (PLACEHOLDER.test(did)) {
    errors.push('IMAJIN_APP_DID is still a placeholder — mint the app identity first (docs/REGISTRATION.md).');
  }
  const appId = get('NEXT_PUBLIC_IMAJIN_APP_ID');
  if (appId !== '' && !appId.startsWith('app_')) {
    errors.push('NEXT_PUBLIC_IMAJIN_APP_ID must be the registry id (app_…).');
  }
  if (PLACEHOLDER.test(appId)) {
    errors.push('NEXT_PUBLIC_IMAJIN_APP_ID is still a placeholder — use the registry id from registration (docs/REGISTRATION.md).');
  }
  const secret = get('SESSION_SECRET');
  if (secret !== '' && (PLACEHOLDER.test(secret) || secret.length < MIN_SESSION_SECRET_LENGTH)) {
    errors.push(`SESSION_SECRET must be a real secret of at least ${MIN_SESSION_SECRET_LENGTH} characters (openssl rand -hex 32), not a placeholder.`);
  }
}

function checkKernelHosts(get, target, errors) {
  for (const name of KERNEL_URL_VARS) {
    if (get(name) !== '') checkKernelUrl(name, get(name), target, errors);
  }
  checkServicePrefix('AUTH_SERVICE_URL', get('AUTH_SERVICE_URL'), '/auth', errors);
  checkServicePrefix('REGISTRY_SERVICE_URL', get('REGISTRY_SERVICE_URL'), '/registry', errors);
  checkServicePrefix('PROFILE_SERVICE_URL', get('PROFILE_SERVICE_URL'), '/profile', errors);
  checkServicePrefix('PAY_SERVICE_URL', get('PAY_SERVICE_URL'), '/pay', errors);

  const hosts = new Set(KERNEL_URL_VARS.filter((name) => get(name) !== '').map((name) => parseUrl(get(name))?.host));
  if (hosts.size > 1) {
    errors.push('The kernel URLs (IMAJIN_AUTH_URL, NEXT_PUBLIC_IMAJIN_AUTH_URL, IMAJIN_KERNEL_URL and the *_SERVICE_URLs) must all point at the same kernel host.');
  }
  if (get('NEXT_PUBLIC_APP_URL') !== '') {
    checkKernelUrl('NEXT_PUBLIC_APP_URL', get('NEXT_PUBLIC_APP_URL'), target, errors);
  }
}

function checkTargetBinding(get, target, errors, warnings) {
  const imajinEnv = get('IMAJIN_ENV');
  if (target === 'dev' && imajinEnv !== 'dev') {
    errors.push('IMAJIN_ENV must be `dev` on the dev instance (selects the imajin_session_dev cookie).');
  }
  if (target === 'prod' && imajinEnv === 'dev') {
    errors.push('IMAJIN_ENV=dev must not be set on prod (it would read the dev session cookie).');
  }

  const wantPrefix = target === 'prod' ? 'https://' : 'https://dev-';
  const prefix = get('NEXT_PUBLIC_SERVICE_PREFIX');
  if (prefix !== '' && prefix !== wantPrefix) {
    errors.push(`NEXT_PUBLIC_SERVICE_PREFIX must be ${wantPrefix} on ${target}.`);
  }

  const port = get('PORT');
  if (port !== '' && port !== String(TARGETS[target].port)) {
    warnings.push(`PORT is set in the env file but ${TARGETS[target].name} runs on ${TARGETS[target].port}; the pm2 entry's value wins.`);
  }
  for (const name of ['ENABLE_APP_LOG', 'LOG_DB_TRANSPORT', 'ENABLE_REQUEST_LOG']) {
    if (get(name) === 'true') {
      warnings.push(`${name}=true — this app is stdout-logging only (AGENTS.md); leave it unset.`);
    }
  }
}

/**
 * Pure validation of a parsed env file for a deploy target. Returns
 * `{ errors, warnings }`; messages name variables, never values.
 *
 * `options.keystoreExists` (true/false, omit to skip the check): whether this
 * app's bootstrap keystore is already on disk. With no keystore the first
 * boot needs IMAJIN_APP_CLAIM_CODE, so the deploy fails here — before pm2 is
 * touched — instead of crash-looping at boot.
 * @param {Record<string, string | undefined>} env
 * @param {'prod' | 'dev'} target
 * @param {{ keystoreExists?: boolean }} [options]
 */
export function validateEnv(env, target, options = {}) {
  if (!(target in TARGETS)) {
    throw new Error(`Unknown target ${JSON.stringify(target)} — expected prod or dev.`);
  }
  const errors = [];
  const warnings = [];
  const get = (name) => (env[name] ?? '').trim();

  for (const variable of ENV_VARS) {
    if (variable.status === 'required' && get(variable.name) === '') {
      errors.push(`${variable.name} is required but not set.`);
    }
    if (variable.status === 'forbidden' && get(variable.name) !== '') {
      errors.push(`${variable.name} must not be set (${variable.summary})`);
    }
  }

  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl !== '' && !/^postgres(ql)?:$/.test(parseUrl(databaseUrl)?.protocol ?? '')) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  if (PLACEHOLDER.test(databaseUrl)) {
    errors.push('DATABASE_URL still contains a placeholder password.');
  }

  const schema = get('APP_DB_SCHEMA');
  if (schema !== '' && schema !== 'learn') {
    errors.push('APP_DB_SCHEMA must be `learn` — the existing schema this app owns; renaming it orphans migration state.');
  }

  const basePath = get('NEXT_PUBLIC_BASE_PATH');
  if (basePath !== '' && basePath !== BASE_PATH) {
    errors.push(`NEXT_PUBLIC_BASE_PATH must be ${BASE_PATH}.`);
  }

  checkKernelHosts(get, target, errors);
  checkIdentity(get, errors);
  checkTargetBinding(get, target, errors, warnings);

  const claimCode = get('IMAJIN_APP_CLAIM_CODE');
  if (claimCode !== '') {
    warnings.push('IMAJIN_APP_CLAIM_CODE is set — it is needed on the first boot only; remove it once the app has booted once.');
  }
  if (claimCode === '' && options.keystoreExists === false) {
    errors.push(
      'No keystore found and IMAJIN_APP_CLAIM_CODE is not set — the first boot needs the one-time claim code from the operator\'s /jin approval card (docs/REGISTRATION.md).',
    );
  }

  return { errors, warnings };
}

/**
 * Reads and parses an env file WITHOUT touching process.env.
 * @param {string} path
 */
export function readEnvFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}
